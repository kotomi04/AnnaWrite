#!/usr/bin/env python3
"""Standalone validator for a built ``registry.json``.

Mirrors the constraints enforced by matrix-nexus
``src/services/preset_apps_registry.py::_parse_registry`` so we catch
bad payloads in CI **before** they're uploaded to R2 (where nexus would
later reject them on startup).

Usage::

    python scripts/validate_preset_registry.py path/to/registry.json [--expect-env staging]

Exit code is non-zero with a human-readable list of errors on failure.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
SLUG_RE = re.compile(r"^[a-z][a-z0-9-]{1,63}$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+([.+-].*)?$")


def _err(errors: list[str], where: str, msg: str) -> None:
    errors.append(f"{where}: {msg}")


def _validate_app(idx: int, app: Any, env: str, errors: list[str]) -> None:
    where = f"apps[{idx}]"
    if not isinstance(app, dict):
        _err(errors, where, "must be an object")
        return

    slug = app.get("slug")
    if not isinstance(slug, str) or not SLUG_RE.match(slug):
        _err(errors, where, f"invalid slug {slug!r}")

    version = app.get("version")
    if not isinstance(version, str) or not SEMVER_RE.match(version):
        _err(errors, where, f"invalid version {version!r}")

    tar_key = app.get("tar_key")
    if not isinstance(tar_key, str) or not tar_key:
        _err(errors, where, "tar_key missing")
    else:
        if ".." in tar_key.split("/"):
            _err(errors, where, f"tar_key contains '..': {tar_key!r}")
        if tar_key.startswith("/"):
            _err(errors, where, f"tar_key must be relative: {tar_key!r}")
        if not tar_key.startswith(f"{env}/"):
            _err(
                errors,
                where,
                f"tar_key must start with '{env}/' (got {tar_key!r})",
            )

    sha = app.get("tar_sha256")
    if not isinstance(sha, str) or not SHA256_RE.match(sha):
        _err(errors, where, f"invalid tar_sha256 {sha!r}")

    size = app.get("tar_size_bytes")
    if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
        _err(errors, where, f"tar_size_bytes must be positive int (got {size!r})")

    for key in ("system", "deprecated"):
        if key in app and not isinstance(app[key], bool):
            _err(errors, where, f"{key} must be bool")

    if "min_nexus_version" in app:
        mnv = app["min_nexus_version"]
        if not isinstance(mnv, str) or not mnv:
            _err(errors, where, "min_nexus_version must be non-empty string")


def validate(registry: dict[str, Any], *, expect_env: str | None = None) -> list[str]:
    errors: list[str] = []

    sv = registry.get("schema_version")
    if sv != SCHEMA_VERSION:
        _err(errors, "schema_version", f"expected {SCHEMA_VERSION}, got {sv!r}")

    env = registry.get("env")
    if not isinstance(env, str) or not env:
        _err(errors, "env", "missing or not a string")
        env = ""
    elif expect_env is not None and env != expect_env:
        _err(errors, "env", f"expected {expect_env!r}, got {env!r}")

    for key in ("generated_at", "source_repo", "source_ref", "source_sha"):
        v = registry.get(key)
        if not isinstance(v, str) or not v:
            _err(errors, key, "missing or not a non-empty string")

    apps = registry.get("apps")
    if not isinstance(apps, list):
        _err(errors, "apps", "must be a list")
        return errors

    seen: set[str] = set()
    for i, app in enumerate(apps):
        _validate_app(i, app, env or "", errors)
        if isinstance(app, dict):
            slug = app.get("slug")
            if isinstance(slug, str):
                if slug in seen:
                    _err(errors, f"apps[{i}]", f"duplicate slug {slug!r}")
                seen.add(slug)

    return errors


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("registry", type=Path, help="path to registry.json")
    p.add_argument(
        "--expect-env",
        choices=("staging", "production"),
        help="fail if registry.env does not match this value",
    )
    args = p.parse_args(argv)

    if not args.registry.is_file():
        print(f"registry not found: {args.registry}", file=sys.stderr)
        return 2

    try:
        data = json.loads(args.registry.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"invalid JSON: {exc}", file=sys.stderr)
        return 2

    errors = validate(data, expect_env=args.expect_env)
    if errors:
        print("registry validation failed:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    apps = data.get("apps", [])
    print(
        f"✓ registry valid: env={data.get('env')} apps={len(apps)} "
        f"source_sha={data.get('source_sha', '')[:12]}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
