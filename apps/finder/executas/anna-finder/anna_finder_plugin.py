#!/usr/bin/env python3
"""
anna-finder — Executa stdio plugin for Anna Persistent Storage (APS).

Exposes ONE tool method (``aps``) selected by an ``action`` discriminator,
following the focus-session single-dispatcher pattern. Each action maps
to an APS reverse-RPC operation:

    list   →  StorageClient.list(prefix=..., cursor=..., limit=...)
    get    →  StorageClient.get(key)
    set    →  StorageClient.set(key, value, if_match=?)
    delete →  StorageClient.delete(key, if_match=?)
    stats  →  list + aggregate (size_bytes, key_count) under prefix

The plugin keeps the bundle's logic minimal: the bundle could call
``anna.storage.*`` directly, but routing through this tool also lets the
``finder-curator`` SKILL (LLM tool path) read & curate APS entries with
the same code, and lets stdio harness fixtures exercise the full surface.

Scope
-----
APS scope defaults to ``"app"`` — the host pins ``owner_id`` to the
calling app's ``app_id``, so an app can only see its own entries.
Standalone (no app_id) callers should pass ``scope="user"`` explicitly,
mirroring the storage-notebook example.

Protocol: JSON-RPC 2.0 over stdio
Methods:  describe, invoke, health
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Optional: executa_sdk for APS reverse-RPC. We make it OPTIONAL so the
# plugin still loads in the harness / standalone shell without the SDK
# installed; in that mode every action returns a deterministic stub so
# the UI stays interactive during local design work.
# ---------------------------------------------------------------------------

_SDK_AVAILABLE = False
_storage = None  # type: ignore[var-annotated]
_route_response = None  # type: ignore[var-annotated]
StorageError: type[Exception] = RuntimeError  # default fallback

try:
    from executa_sdk import (  # type: ignore[import-not-found]
        StorageClient,
        StorageError as _StorageError,
        make_response_router,
    )
    from executa_sdk.storage import (  # type: ignore[import-not-found]
        STORAGE_ERR_PRECONDITION_FAILED,
    )
    _storage = StorageClient()
    _route_response = make_response_router(_storage)
    StorageError = _StorageError
    _SDK_AVAILABLE = True
except Exception:  # pragma: no cover — SDK absent is fine for harness
    STORAGE_ERR_PRECONDITION_FAILED = "precondition_failed"

_loop: asyncio.AbstractEventLoop | None = None
_executor = ThreadPoolExecutor(max_workers=4)


# ---------------------------------------------------------------------------
# Plugin manifest
# ---------------------------------------------------------------------------

MANIFEST: dict[str, Any] = {
    # First-party reserved namespace (see matrix-nexus id_mint.RESERVED_HANDLES).
    # Do NOT mint this via /executa — the platform seeder owns it.
    "name": "tool-anna-finder",
    "display_name": "Anna Finder",
    "version": "1.2.0",
    "description": (
        "Browse and curate Anna Persistent Storage (APS) entries for the "
        "current app/user. Wraps storage.list / get / set / delete with "
        "pagination, optimistic concurrency, and per-prefix size stats."
    ),
    "author": "Anna Apps",
    "homepage": "https://anna.partners/apps/finder",
    "license": "MIT",
    "tags": ["utilities", "storage", "aps", "anna-app"],
    # Required so the host mints a storage_token for reverse-RPC.
    # `aps.kv` covers the default scope=app self-owned bucket; the
    # `aps.scope.user.*` strings opt-in to cross-scope access (the user
    # must additionally toggle each scope ON in Settings → Executas →
    # Permissions before the host honours them).
    "host_capabilities": [
        "aps.kv",
        "aps.scope.user.read",
        "aps.scope.user.write",
    ],
    "tools": [
        {
            "name": "aps",
            "description": (
                "Anna Persistent Storage operations. Use the `action` "
                "parameter to select the op. Default scope is 'app' "
                "(per-app namespace owned by the calling Anna App)."
            ),
            "parameters": [
                {
                    "name": "action",
                    "type": "string",
                    "description": (
                        "One of: list, get, set, delete, stats."
                    ),
                    "required": True,
                    "enum": ["list", "get", "set", "delete", "stats"],
                },
                {
                    "name": "scope",
                    "type": "string",
                    "description": (
                        "APS scope: 'app' (default), 'user', or 'tool'. "
                        "Standalone callers (no app_id) should pass 'user'."
                    ),
                    "required": False,
                    "default": "app",
                    "enum": ["app", "user", "tool"],
                },
                {
                    "name": "prefix",
                    "type": "string",
                    "description": (
                        "Key prefix for action='list' / 'stats'. Empty = all."
                    ),
                    "required": False,
                    "default": "",
                },
                {
                    "name": "cursor",
                    "type": "string",
                    "description": "Pagination cursor returned by a previous list call.",
                    "required": False,
                    "default": "",
                },
                {
                    "name": "limit",
                    "type": "integer",
                    "description": "Page size for action='list' (1-500, default 100).",
                    "required": False,
                    "default": 100,
                },
                {
                    "name": "key",
                    "type": "string",
                    "description": "Entry key for get / set / delete.",
                    "required": False,
                    "default": "",
                },
                {
                    "name": "value",
                    "type": "object",
                    "description": (
                        "JSON-serialisable payload for action='set'. May be "
                        "any value (object, array, string, number, bool, null)."
                    ),
                    "required": False,
                },
                {
                    "name": "if_match",
                    "type": "string",
                    "description": (
                        "Etag returned by a previous get/set. When supplied, "
                        "set/delete fail with STORAGE_PRECONDITION_FAILED if "
                        "the entry has changed."
                    ),
                    "required": False,
                    "default": "",
                },
                {
                    "name": "ttl_seconds",
                    "type": "integer",
                    "description": "Optional TTL for action='set' (0 = none).",
                    "required": False,
                    "default": 0,
                },
            ],
        },
    ],
    "runtime": {"type": "uv", "min_version": "0.1.0"},
}


# ---------------------------------------------------------------------------
# In-memory standalone fallback (used when executa_sdk isn't reachable —
# e.g. local CLI dev without the host bridge). Keys are namespaced by
# scope so the UI behaves the same offline.
# ---------------------------------------------------------------------------


class _Stub:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._data: dict[str, dict[str, dict[str, Any]]] = {
            "app": {}, "user": {}, "tool": {},
        }

    @staticmethod
    def _etag(value: Any, gen: int) -> str:
        import hashlib
        h = hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()
        return f'W/"{gen}-{h[:16]}"'

    def get(self, scope: str, key: str) -> dict:
        with self._lock:
            entry = self._data.get(scope, {}).get(key)
            if entry is None:
                return {"value": None, "exists": False}
            return {
                "value": entry["value"],
                "etag": entry["etag"],
                "generation": entry["generation"],
                "exists": True,
            }

    def set(self, scope: str, key: str, value: Any, if_match: str | None) -> dict:
        with self._lock:
            cur = self._data.setdefault(scope, {}).get(key)
            if if_match and (cur is None or cur["etag"] != if_match):
                raise StubPreconditionError("etag mismatch")
            gen = (cur["generation"] + 1) if cur else 1
            etag = self._etag(value, gen)
            payload = json.dumps(value, default=str)
            entry = {
                "value": value,
                "etag": etag,
                "generation": gen,
                "size_bytes": len(payload.encode("utf-8")),
                "updated_at": time.time(),
                "metadata": None,
                "tags": None,
            }
            self._data[scope][key] = entry
            return {
                "etag": etag,
                "generation": gen,
                "size_bytes": entry["size_bytes"],
            }

    def delete(self, scope: str, key: str, if_match: str | None) -> dict:
        with self._lock:
            cur = self._data.get(scope, {}).get(key)
            if cur is None:
                return {"deleted": True}
            if if_match and cur["etag"] != if_match:
                raise StubPreconditionError("etag mismatch")
            self._data[scope].pop(key, None)
            return {"deleted": True}

    def list(self, scope: str, prefix: str, cursor: str | None, limit: int) -> dict:
        with self._lock:
            keys = sorted(k for k in self._data.get(scope, {}) if k.startswith(prefix or ""))
            start = 0
            if cursor:
                try:
                    start = int(cursor)
                except ValueError:
                    start = 0
            page = keys[start : start + limit]
            items = []
            for k in page:
                e = self._data[scope][k]
                items.append({
                    "key": k,
                    "etag": e["etag"],
                    "size_bytes": e["size_bytes"],
                    "metadata": e.get("metadata"),
                    "tags": e.get("tags"),
                    "updated_at": _iso(e.get("updated_at")),
                })
            next_cursor = str(start + limit) if (start + limit) < len(keys) else None
            return {"items": items, "next_cursor": next_cursor}


class StubPreconditionError(Exception):
    code = STORAGE_ERR_PRECONDITION_FAILED


_stub_storage = _Stub()


def _iso(ts: float | None) -> str | None:
    if not ts:
        return None
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Async dispatch — routes either to the SDK reverse-RPC client or the stub.
# ---------------------------------------------------------------------------


def _clamp_limit(raw: Any) -> int:
    try:
        n = int(raw)
    except (TypeError, ValueError):
        n = 100
    return max(1, min(n, 500))


async def _aps_list(scope: str, prefix: str, cursor: str, limit: int) -> dict:
    if _SDK_AVAILABLE and _storage is not None:
        kwargs: dict[str, Any] = {"scope": scope, "limit": limit}
        if prefix:
            kwargs["prefix"] = prefix
        if cursor:
            kwargs["cursor"] = cursor
        return await _storage.list(**kwargs)
    return _stub_storage.list(scope, prefix or "", cursor or None, limit)


async def _aps_get(scope: str, key: str) -> dict:
    if not key:
        raise ValueError("key is required")
    if _SDK_AVAILABLE and _storage is not None:
        return await _storage.get(key, scope=scope)
    return _stub_storage.get(scope, key)


async def _aps_set(
    scope: str, key: str, value: Any, if_match: str, ttl_seconds: int
) -> dict:
    if not key:
        raise ValueError("key is required")
    if _SDK_AVAILABLE and _storage is not None:
        kwargs: dict[str, Any] = {"scope": scope}
        if if_match:
            kwargs["if_match"] = if_match
        if ttl_seconds and ttl_seconds > 0:
            kwargs["ttl_seconds"] = int(ttl_seconds)
        return await _storage.set(key, value, **kwargs)
    return _stub_storage.set(scope, key, value, if_match or None)


async def _aps_delete(scope: str, key: str, if_match: str) -> dict:
    if not key:
        raise ValueError("key is required")
    if _SDK_AVAILABLE and _storage is not None:
        kwargs: dict[str, Any] = {"scope": scope}
        if if_match:
            kwargs["if_match"] = if_match
        return await _storage.delete(key, **kwargs)
    return _stub_storage.delete(scope, key, if_match or None)


async def _aps_stats(scope: str, prefix: str) -> dict:
    """Walk all pages under prefix and aggregate. Capped at 5k entries."""
    total_size = 0
    total_keys = 0
    cursor: str | None = None
    folders: dict[str, dict[str, int]] = {}
    last_updated: str | None = None
    pages = 0
    while True:
        page = await _aps_list(scope, prefix, cursor or "", 500)
        items = page.get("items") or []
        for it in items:
            total_keys += 1
            total_size += int(it.get("size_bytes") or 0)
            updated = it.get("updated_at")
            if updated and (last_updated is None or updated > last_updated):
                last_updated = updated
            # First-segment bucket for a tree-style summary.
            key = it.get("key") or ""
            head = key.split("/", 1)[0] if "/" in key else key
            f = folders.setdefault(head, {"size": 0, "count": 0})
            f["size"] += int(it.get("size_bytes") or 0)
            f["count"] += 1
        cursor = page.get("next_cursor")
        pages += 1
        if not cursor or total_keys >= 5000 or pages >= 20:
            break
    return {
        "scope": scope,
        "prefix": prefix or "",
        "total_keys": total_keys,
        "total_size": total_size,
        "last_updated": last_updated,
        "buckets": [
            {"name": name, "size": v["size"], "count": v["count"]}
            for name, v in sorted(folders.items())
        ],
    }


async def _dispatch_aps(
    *,
    action: str,
    scope: str = "app",
    prefix: str = "",
    cursor: str = "",
    limit: int = 100,
    key: str = "",
    value: Any = None,
    if_match: str = "",
    ttl_seconds: int = 0,
) -> dict:
    scope = scope or "app"
    if action == "list":
        return await _aps_list(scope, prefix, cursor, _clamp_limit(limit))
    if action == "get":
        return await _aps_get(scope, key)
    if action == "set":
        return await _aps_set(scope, key, value, if_match, int(ttl_seconds or 0))
    if action == "delete":
        return await _aps_delete(scope, key, if_match)
    if action == "stats":
        return await _aps_stats(scope, prefix)
    raise ValueError(
        f"unknown action: {action!r}; expected one of "
        "list | get | set | delete | stats"
    )


# ---------------------------------------------------------------------------
# JSON-RPC handlers
# ---------------------------------------------------------------------------


def _run_async(coro: Any) -> Any:
    """Run an async coroutine on the dedicated event loop."""
    global _loop
    if _loop is None or _loop.is_closed():
        _loop = asyncio.new_event_loop()
        threading.Thread(target=_loop.run_forever, name="aps-loop", daemon=True).start()
    fut = asyncio.run_coroutine_threadsafe(coro, _loop)
    return fut.result(timeout=60)


def handle_describe(_params: dict[str, Any]) -> dict[str, Any]:
    # Bare manifest — Matrix's ToolManifest.from_dict reads data["name"]
    # directly from the JSON-RPC `result`. Wrapping it would KeyError.
    return MANIFEST


def handle_invoke(params: dict[str, Any]) -> Any:
    tool_name = params.get("tool")
    args = params.get("arguments") or {}
    if not isinstance(args, dict):
        raise ValueError("`arguments` must be an object")
    if tool_name != "aps":
        raise ValueError(f"unknown tool: {tool_name!r}")
    # Asymmetric to describe: invoke MUST be wrapped {"success", "data"}.
    try:
        payload = _run_async(_dispatch_aps(**args))
    except StorageError as exc:  # type: ignore[misc]
        code = getattr(exc, "code", "storage_error")
        msg = getattr(exc, "message", str(exc))
        return {"success": False, "error": f"{code}: {msg}", "code": code}
    except StubPreconditionError as exc:
        return {
            "success": False,
            "error": f"{exc.code}: {exc}",
            "code": exc.code,
        }
    except Exception as exc:  # surface tool errors via InvokeResult
        return {"success": False, "error": f"{type(exc).__name__}: {exc}"}
    return {"success": True, "data": payload}


def handle_health(_params: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "ok",
        "sdk_available": _SDK_AVAILABLE,
        "mode": "aps" if _SDK_AVAILABLE else "stub",
    }


METHOD_DISPATCH = {
    "describe": handle_describe,
    "invoke": handle_invoke,
    "health": handle_health,
}


# ---------------------------------------------------------------------------
# Stdio loop
# ---------------------------------------------------------------------------

def _route_storage_response(msg: dict) -> bool:
    """Route a server-pushed RPC response into the StorageClient if relevant.

    Returns True if the message was consumed (so the main loop should not
    treat it as a request).
    """
    if not _SDK_AVAILABLE or _route_response is None:
        return False
    try:
        return bool(_route_response(msg))
    except Exception:
        return False


def send(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    print(
        f"[anna-finder] {MANIFEST['display_name']} v{MANIFEST['version']} "
        f"ready (mode={'aps' if _SDK_AVAILABLE else 'stub'})",
        file=sys.stderr,
    )
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError as e:
            send(
                {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {"code": -32700, "message": f"parse error: {e}"},
                }
            )
            continue

        # Reverse-RPC responses from the host (storage/* results) get
        # routed to the StorageClient; never treat them as requests.
        if _route_storage_response(message):
            continue

        req_id = message.get("id")
        method = message.get("method")
        params = message.get("params") or {}
        handler = METHOD_DISPATCH.get(method)
        if handler is None:
            send(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {
                        "code": -32601,
                        "message": f"method not found: {method}",
                    },
                }
            )
            continue
        try:
            result = handler(params)
            send({"jsonrpc": "2.0", "id": req_id, "result": result})
        except Exception as exc:  # noqa: BLE001
            send(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32000, "message": str(exc)},
                }
            )


if __name__ == "__main__":
    main()
