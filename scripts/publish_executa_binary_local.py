#!/usr/bin/env python3
"""Build a single-platform executa binary and upload to R2 ``local/``.

Developer counterpart of ``.github/workflows/release-executa.yml``.
Use this when iterating on the executa binary itself and you want to
exercise the full ``BinaryRuntime`` install path locally (download from
R2 + SHA256 verify + extract under ``~/.anna/executa/tools/``) rather
than dropping the binary straight into ``~/.anna/executa/bin/``.

Pairs with matrix-nexus' ``DEPLOY_ENV=local`` (the default for dev
deploys): the first-party seeder auto-rewrites pyproject's
``production`` URLs to ``<DEPLOY_ENV>`` for any non-prod env, so the
Agent fetches the binary this script just pushed to ``local/``.

Usage::

    # Build current platform's binary for anna-finder and push to local/
    python scripts/publish_executa_binary_local.py apps/finder/executas/anna-finder

    # Override anything:
    python scripts/publish_executa_binary_local.py apps/finder/executas/anna-finder \\
        --bucket anna-preset-apps \\
        --prefix local \\
        --env-file ../matrix-nexus/.env

    # Just build, don't touch R2:
    python scripts/publish_executa_binary_local.py apps/finder/executas/anna-finder \\
        --dry-run

Required credentials (env vars or ``.env`` keys, names match matrix-nexus):
    R2_ACCOUNT_ID
    R2_ACCESS_KEY_ID
    R2_SECRET_ACCESS_KEY

Optional:
    R2_ENDPOINT_URL   — overrides the derived
                        https://<ACCOUNT_ID>.r2.cloudflarestorage.com
"""

from __future__ import annotations

import argparse
import hashlib
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import zipfile
from pathlib import Path
from typing import Optional


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ENV_FILE = REPO_ROOT.parent / "matrix-nexus" / ".env"
DEFAULT_BUCKET = "anna-preset-apps"
DEFAULT_PREFIX = "local"


# ---------------------------------------------------------------------------
# .env loading (mirrors publish_preset_registry_local.py)
# ---------------------------------------------------------------------------


def _load_env_file(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    out: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in {'"', "'"}:
            val = val[1:-1]
        if key:
            out[key] = val
    return out


def _resolve(name: str, *, cli_value: str | None, file_env: dict[str, str]) -> str | None:
    if cli_value:
        return cli_value
    if v := os.environ.get(name):
        return v
    return file_env.get(name)


# ---------------------------------------------------------------------------
# Platform detection — must match matrix.src.executa.runtime.get_platform_key()
# ---------------------------------------------------------------------------


def _platform_key() -> str:
    system = platform.system().lower()
    if system == "darwin":
        os_part = "darwin"
    elif system == "linux":
        os_part = "linux"
    elif system in {"windows", "win32"}:
        os_part = "windows"
    else:
        raise SystemExit(f"unsupported OS for local build: {system}")

    machine = platform.machine().lower()
    if machine in {"x86_64", "amd64"}:
        arch = "x86_64"
    elif machine in {"arm64", "aarch64"}:
        # macOS reports ``arm64``; Linux reports ``aarch64``. CI uses the
        # native name; mirror it here so the asset filename round-trips.
        arch = "arm64" if os_part == "darwin" else "aarch64"
    else:
        raise SystemExit(f"unsupported arch for local build: {machine}")

    return f"{os_part}-{arch}"


def _archive_ext(plat: str) -> str:
    return "zip" if plat.startswith("windows-") else "tar.gz"


# ---------------------------------------------------------------------------
# Build (delegates to build_binary.sh)
# ---------------------------------------------------------------------------


def _read_pyproject(executa_dir: Path) -> tuple[str, str]:
    pyproject = executa_dir / "pyproject.toml"
    if not pyproject.is_file():
        raise SystemExit(f"pyproject.toml not found under {executa_dir}")
    data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    project = data.get("project") or {}
    tool_id = (project.get("name") or "").strip()
    version = (project.get("version") or "").strip()
    if not tool_id or not version:
        raise SystemExit(
            f"{pyproject}: [project].name and [project].version are required"
        )
    return tool_id, version


def _build(executa_dir: Path) -> Path:
    build_script = executa_dir / "build_binary.sh"
    if not build_script.is_file():
        raise SystemExit(
            f"no build_binary.sh under {executa_dir} — "
            f"add one (see apps/finder/executas/anna-finder/build_binary.sh)"
        )
    print(f"$ {build_script}", file=sys.stderr)
    # ``--clean`` so stale dist/ from a prior platform's build can't leak in.
    subprocess.run(
        ["bash", str(build_script), "--clean"], check=True, cwd=executa_dir
    )
    plat = _platform_key()
    ext = _archive_ext(plat)
    asset = executa_dir / "dist" / f"{plat}.{ext}"
    legacy_asset = executa_dir / "dist" / f"tool-anna-finder-{plat}.{ext}"
    if asset.is_file():
        return asset
    # build_binary.sh currently emits the legacy ``<tool>-<platform>.<ext>``
    # naming. Normalize to the flat ``<platform>.<ext>`` shape the workflow
    # (and R2 layout) uses so the local + CI artefacts are interchangeable.
    if legacy_asset.is_file():
        normalized = executa_dir / "dist" / f"{plat}.{ext}"
        shutil.copy2(legacy_asset, normalized)
        return normalized
    raise SystemExit(
        f"build did not produce expected archive at {asset} or {legacy_asset}"
    )


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def _write_sidecar(asset: Path) -> Path:
    digest = _sha256(asset)
    sidecar = asset.with_suffix(asset.suffix + ".sha256")
    # Match shasum -a 256 format: ``<hex>  <filename>\n``
    sidecar.write_text(f"{digest}  {asset.name}\n", encoding="utf-8")
    return sidecar


def _verify_archive(asset: Path) -> None:
    """Sanity-check the archive opens and contains the expected entry."""
    if asset.suffix == ".gz":
        with tarfile.open(asset, "r:gz") as tar:
            names = tar.getnames()
    elif asset.suffix == ".zip":
        with zipfile.ZipFile(asset) as zf:
            names = zf.namelist()
    else:
        return
    if not names:
        raise SystemExit(f"{asset} appears empty")


# ---------------------------------------------------------------------------
# Upload
# ---------------------------------------------------------------------------


def _upload(
    *,
    asset: Path,
    sidecar: Path,
    bucket: str,
    key_prefix: str,
    endpoint_url: str,
    access_key_id: str,
    secret_access_key: str,
) -> None:
    try:
        import boto3  # type: ignore[import-not-found]
        from botocore.config import Config  # type: ignore[import-not-found]
    except ImportError as exc:
        raise SystemExit(
            "boto3 is required. `pip install boto3` "
            "(or `source ../matrix-nexus/.venv/bin/activate`)."
        ) from exc

    s3 = boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        region_name="auto",
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )

    for path, content_type in [
        (asset, "application/octet-stream"),
        (sidecar, "text/plain"),
    ]:
        key = f"{key_prefix}/{path.name}"
        print(
            f"  ↑ s3://{bucket}/{key}  ({path.stat().st_size}B)",
            file=sys.stderr,
        )
        s3.upload_file(
            Filename=str(path),
            Bucket=bucket,
            Key=key,
            ExtraArgs={
                "ContentType": content_type,
                "CacheControl": "public, max-age=31536000, immutable",
            },
        )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument(
        "executa_dir",
        type=Path,
        help="Path to apps/<slug>/executas/<sub>/ (must contain pyproject.toml + build_binary.sh)",
    )
    p.add_argument("--bucket", default=DEFAULT_BUCKET)
    p.add_argument(
        "--prefix",
        default=DEFAULT_PREFIX,
        help=(
            "R2 env prefix. Default ``local`` — paired with "
            "matrix-nexus' ``DEPLOY_ENV=local`` (seeder auto-rewrites "
            "pyproject URLs to the active deploy env on non-prod). "
            "Do NOT use ``staging`` / ``production`` from a dev laptop."
        ),
    )
    p.add_argument("--env-file", type=Path, default=DEFAULT_ENV_FILE)
    p.add_argument("--endpoint-url", default=None)
    p.add_argument("--account-id", default=None)
    p.add_argument("--access-key-id", default=None)
    p.add_argument("--secret-access-key", default=None)
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Build + print expected R2 key; don't upload.",
    )
    args = p.parse_args(argv)

    executa_dir = args.executa_dir.resolve()
    if not executa_dir.is_dir():
        raise SystemExit(f"not a directory: {executa_dir}")

    if args.prefix in {"staging", "production"}:
        print(
            f"⚠ refusing to publish to '{args.prefix}/' from a developer machine — "
            f"that prefix is owned by the release CI. Use 'local/' (default).",
            file=sys.stderr,
        )
        return 2

    tool_id, version = _read_pyproject(executa_dir)
    plat = _platform_key()
    ext = _archive_ext(plat)
    key_prefix = f"{args.prefix}/executas/{tool_id}/{version}"
    expected_key = f"{key_prefix}/{plat}.{ext}"

    print(f"→ tool_id : {tool_id}", file=sys.stderr)
    print(f"→ version : {version}", file=sys.stderr)
    print(f"→ platform: {plat}", file=sys.stderr)
    print(f"→ R2 key  : s3://{args.bucket}/{expected_key}", file=sys.stderr)

    asset = _build(executa_dir)
    _verify_archive(asset)
    sidecar = _write_sidecar(asset)
    print(
        f"→ built   : {asset.relative_to(REPO_ROOT)}  "
        f"(sha256 in {sidecar.name})",
        file=sys.stderr,
    )

    if args.dry_run:
        print("✓ dry-run complete; skipped upload.", file=sys.stderr)
        return 0

    file_env = _load_env_file(args.env_file)
    account_id = _resolve(
        "R2_ACCOUNT_ID", cli_value=args.account_id, file_env=file_env
    )
    access_key = _resolve(
        "R2_ACCESS_KEY_ID", cli_value=args.access_key_id, file_env=file_env
    )
    secret_key = _resolve(
        "R2_SECRET_ACCESS_KEY", cli_value=args.secret_access_key, file_env=file_env
    )
    endpoint = args.endpoint_url or _resolve(
        "R2_ENDPOINT_URL", cli_value=None, file_env=file_env
    )
    if not endpoint:
        if not account_id:
            raise SystemExit("must set R2_ACCOUNT_ID (env, --env-file, or --account-id)")
        endpoint = f"https://{account_id}.r2.cloudflarestorage.com"
    if not access_key or not secret_key:
        raise SystemExit(
            "missing R2 credentials — set R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY "
            f"in env or {args.env_file}"
        )

    _upload(
        asset=asset,
        sidecar=sidecar,
        bucket=args.bucket,
        key_prefix=key_prefix,
        endpoint_url=endpoint,
        access_key_id=access_key,
        secret_access_key=secret_key,
    )

    print("", file=sys.stderr)
    print(
        f"✓ published https://bin.anna.partners/{key_prefix}/{plat}.{ext}",
        file=sys.stderr,
    )
    print(
        "  matrix-nexus will pick this up on next start when its "
        f"DEPLOY_ENV matches '{args.prefix}' (seeder rewrites the URL "
        "automatically on any non-production deploy).",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
