from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from anna_app_runtime_local.bridge import _Bridge, _err
from anna_app_runtime_local.executa import ExecutaPool, _PluginError


_ORIGINAL_INVOKE = ExecutaPool.invoke


async def _windows_direct_invoke(
    self: ExecutaPool, *, tool_id: str, tool_name: str, tool_args: dict
) -> dict[str, Any]:
    spec = self._specs.get(tool_id)
    if spec is None:
        raise KeyError(f"executa '{tool_id}' is not registered with the harness")

    plugin = _find_plugin(Path(spec.project_dir))
    if plugin is None:
        return await _ORIGINAL_INVOKE(
            self, tool_id=tool_id, tool_name=tool_name, tool_args=tool_args
        )

    env = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "invoke",
        "params": {"tool": tool_name, "arguments": tool_args},
    }

    def run_once() -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [_python_for_project(Path(spec.project_dir)), str(plugin)],
            input=(json.dumps(env, ensure_ascii=True) + "\n").encode("utf-8"),
            capture_output=True,
            cwd=spec.project_dir,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            timeout=65,
        )

    try:
        proc = await asyncio.to_thread(run_once)
    except subprocess.TimeoutExpired:
        raise _PluginError(f"executa '{tool_id}' timed out")

    stdout = (proc.stdout or b"").decode("utf-8", "replace")
    stderr = (proc.stderr or b"").decode("utf-8", "replace")

    if proc.returncode != 0:
        error = (stderr or stdout or f"exit code {proc.returncode}").strip()
        return {
            "success": True,
            "data": {"success": False, "error": error},
            "command_id": "local",
        }

    first_json = next(
        (line for line in stdout.splitlines() if line.strip().startswith("{")),
        "",
    )
    if not first_json:
        stderr = stderr.strip()
        return {
            "success": True,
            "data": {
                "success": False,
                "error": f"plugin produced no JSON-RPC response"
                + (f": {stderr}" if stderr else ""),
            },
            "command_id": "local",
        }

    try:
        msg = json.loads(first_json)
    except json.JSONDecodeError as exc:
        return {
            "success": True,
            "data": {
                "success": False,
                "error": f"plugin produced invalid JSON-RPC response: {exc}",
            },
            "command_id": "local",
        }

    if "error" in msg:
        err = msg["error"] or {}
        return {
            "success": True,
            "data": {
                "success": False,
                "error": f"[{err.get('code', '?')}] {err.get('message', 'unknown error')}",
            },
            "command_id": "local",
        }
    return {"success": True, "data": msg.get("result"), "command_id": "local"}


def _find_plugin(project_dir: Path) -> Path | None:
    preferred = project_dir / "mini_notes_plugin.py"
    if preferred.exists():
        return preferred
    matches = sorted(project_dir.glob("*_plugin.py"))
    return matches[0] if matches else None


def _python_for_project(project_dir: Path) -> str:
    local = project_dir / ".venv" / "Scripts" / "python.exe"
    if local.exists():
        return str(local)
    return getattr(sys, "_base_executable", sys.executable)


ExecutaPool.invoke = _windows_direct_invoke


async def _readline() -> bytes:
    return await asyncio.to_thread(sys.stdin.buffer.readline)


async def _run() -> None:
    bridge = _Bridge()

    sys.stdout.write(
        json.dumps({"jsonrpc": "2.0", "method": "_ready", "params": {}}) + "\n"
    )
    sys.stdout.flush()

    while True:
        line = await _readline()
        if not line:
            return
        text = line.decode("utf-8").strip()
        if not text:
            continue

        try:
            req = json.loads(text)
        except json.JSONDecodeError:
            sys.stdout.write(json.dumps(_err(None, -32700, "parse error")) + "\n")
            sys.stdout.flush()
            continue

        if not isinstance(req, dict):
            sys.stdout.write(
                json.dumps(_err(None, -32600, "request must be an object")) + "\n"
            )
            sys.stdout.flush()
            continue

        resp = await bridge.handle(req)
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()


def main() -> None:
    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
