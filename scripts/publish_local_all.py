#!/usr/bin/env python3
"""One-shot local publish: every executa binary + the preset registry.

Walks ``apps/*/executas/*/pyproject.toml`` and, for any executa that
declares ``[tool.anna.executa] binary_urls``, invokes
``publish_executa_binary_local.py`` to build + upload the current
platform's binary to ``s3://anna-preset-apps/local/executas/...``.
Then runs ``publish_preset_registry_local.py`` to refresh the registry.

Use this when you want a single command that brings a local
matrix-nexus (``DEPLOY_ENV=local``) fully in sync with this checkout.

Skips executas without ``binary_urls`` (pure-Python uv packages) — those
don't need pre-built binaries on R2.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APPS_DIR = ROOT / "apps"
SCRIPTS = Path(__file__).resolve().parent


def _has_binary_urls(pyproject: Path) -> bool:
    try:
        data = tomllib.loads(pyproject.read_text("utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        return False
    return bool(data.get("tool", {}).get("anna", {}).get("executa", {}).get("binary_urls"))


def _find_binary_executas() -> list[Path]:
    out: list[Path] = []
    for pp in sorted(APPS_DIR.glob("*/executas/*/pyproject.toml")):
        if _has_binary_urls(pp):
            out.append(pp.parent)
    return out


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--skip-binaries",
        action="store_true",
        help="Only refresh the preset registry; don't rebuild executa binaries.",
    )
    p.add_argument(
        "--skip-registry",
        action="store_true",
        help="Only (re)publish executa binaries; don't touch the registry.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="List what would happen; don't shell out.",
    )
    args = p.parse_args()

    failures: list[str] = []

    if not args.skip_binaries:
        executas = _find_binary_executas()
        if not executas:
            print("→ no executas with [tool.anna.executa].binary_urls found", file=sys.stderr)
        for executa_dir in executas:
            rel = executa_dir.relative_to(ROOT)
            print(f"\n=== executa: {rel} ===", file=sys.stderr)
            if args.dry_run:
                print(
                    f"  would run: publish_executa_binary_local.py {rel}",
                    file=sys.stderr,
                )
                continue
            rc = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS / "publish_executa_binary_local.py"),
                    str(executa_dir),
                ],
                cwd=ROOT,
            ).returncode
            if rc != 0:
                failures.append(f"executa {rel} (exit {rc})")

    if not args.skip_registry:
        print("\n=== preset registry ===", file=sys.stderr)
        if args.dry_run:
            print("  would run: publish_preset_registry_local.py", file=sys.stderr)
        else:
            rc = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS / "publish_preset_registry_local.py"),
                ],
                cwd=ROOT,
            ).returncode
            if rc != 0:
                failures.append(f"preset registry (exit {rc})")

    if failures:
        print("\n❌ failures:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1
    print("\n✓ all done", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
