#!/usr/bin/env python3
"""Build and publish a *local* preset-apps registry to R2.

This is the developer counterpart of
``.github/workflows/publish-preset-registry.yml``. It uploads under the
``local/`` key prefix in the ``anna-preset-apps`` bucket so a locally
running matrix-nexus (``DEPLOY_ENV=local``) can successfully fetch
``s3://anna-preset-apps/local/registry.json`` on startup.

Why a separate script?
  - The GitHub workflow only publishes ``staging`` and ``production``.
  - Letting devs publish to those prefixes from laptops is dangerous;
    ``local/`` is private to whoever holds the credential and never read
    by deployed environments.
  - It bundles build + upload in one command and reads R2 credentials
    straight from ``matrix-nexus/.env`` so there is nothing else to wire.

Usage::

    # Reads R2 creds from ../matrix-nexus/.env (or --env-file).
    python scripts/publish_preset_registry_local.py

    # Override anything:
    python scripts/publish_preset_registry_local.py \\
        --apps-dir apps \\
        --bucket anna-preset-apps \\
        --prefix local \\
        --env-file ../matrix-nexus/.env

    # Just build, don't touch R2:
    python scripts/publish_preset_registry_local.py --dry-run --output-dir /tmp/reg

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
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Iterable


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ENV_FILE = REPO_ROOT.parent / "matrix-nexus" / ".env"
DEFAULT_BUCKET = "anna-preset-apps"
DEFAULT_PREFIX = "local"


# ---------------------------------------------------------------------------
# .env loading (no python-dotenv dependency)
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
        # Strip optional surrounding quotes — matches docker/uvicorn .env
        # parsing well enough for our handful of R2_* keys.
        if len(val) >= 2 and val[0] == val[-1] and val[0] in {'"', "'"}:
            val = val[1:-1]
        if key:
            out[key] = val
    return out


def _resolve_setting(
    name: str, *, cli_value: str | None, file_env: dict[str, str]
) -> str | None:
    if cli_value:
        return cli_value
    # Real env beats .env so an explicit shell export wins.
    if v := os.environ.get(name):
        return v
    return file_env.get(name)


# ---------------------------------------------------------------------------
# Build step (delegates to build_preset_registry.py)
# ---------------------------------------------------------------------------


def _build(
    *, apps_dir: Path, prefix: str, source_sha: str, output_dir: Path
) -> None:
    builder = REPO_ROOT / "scripts" / "build_preset_registry.py"
    if not builder.is_file():
        raise SystemExit(f"missing builder script: {builder}")

    cmd = [
        sys.executable,
        str(builder),
        "--apps-dir",
        str(apps_dir),
        "--env",
        prefix,
        "--source-sha",
        source_sha,
        "--source-ref",
        "local",
        "--output-dir",
        str(output_dir),
    ]
    print(f"$ {' '.join(cmd)}", file=sys.stderr)
    subprocess.run(cmd, check=True)


# ---------------------------------------------------------------------------
# Upload step (boto3)
# ---------------------------------------------------------------------------


def _iter_tar_objects(output_dir: Path) -> Iterable[tuple[Path, str]]:
    """Yield (local_path, key_relative_to_output_dir) pairs for everything
    under the build dir except ``registry.json`` itself.

    ``build_preset_registry.py`` already namespaces files under ``<env>/``
    via ``tar_key`` but writes them at the **root** of ``output_dir``
    as ``<slug>/<version>/app.tar.gz``. The S3 layout must match
    ``tar_key`` exactly, so we prefix each upload with ``<prefix>/``
    when computing the destination key.
    """
    for path in sorted(output_dir.rglob("*")):
        if not path.is_file():
            continue
        if path.name == "registry.json":
            continue
        rel = path.relative_to(output_dir)
        yield path, rel.as_posix()


def _upload(
    *,
    output_dir: Path,
    bucket: str,
    prefix: str,
    endpoint_url: str,
    access_key_id: str,
    secret_access_key: str,
) -> None:
    try:
        import boto3  # type: ignore[import-not-found]
        from botocore.config import Config  # type: ignore[import-not-found]
    except ImportError as exc:
        raise SystemExit(
            "boto3 is required for upload. Install with `pip install boto3` "
            "or run inside the matrix-nexus venv:\n"
            "    source ../matrix-nexus/.venv/bin/activate"
        ) from exc

    s3 = boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        region_name="auto",
        # SigV4 + path-style is what R2 wants and matches matrix-nexus'
        # boto3 setup so behaviour is consistent.
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )

    # Phase 1: tarballs (+ .sha256 sidecars) — long-cache, immutable.
    uploaded = 0
    for local_path, rel_key in _iter_tar_objects(output_dir):
        key = f"{prefix}/{rel_key}"
        content_type = (
            "application/gzip"
            if local_path.suffix == ".gz"
            else "text/plain"
            if local_path.suffix == ".sha256"
            else "application/octet-stream"
        )
        print(f"  ↑ s3://{bucket}/{key}  ({local_path.stat().st_size}B)", file=sys.stderr)
        s3.upload_file(
            Filename=str(local_path),
            Bucket=bucket,
            Key=key,
            ExtraArgs={
                "ContentType": content_type,
                "CacheControl": "public, max-age=31536000, immutable",
            },
        )
        uploaded += 1

    # Phase 2: registry.json LAST so nexus never sees a manifest whose
    # tar_key points at an object that hasn't been uploaded yet.
    registry_path = output_dir / "registry.json"
    if not registry_path.is_file():
        raise SystemExit(f"registry.json missing under {output_dir}")
    registry_key = f"{prefix}/registry.json"
    print(f"  ↑ s3://{bucket}/{registry_key}  (registry.json)", file=sys.stderr)
    s3.upload_file(
        Filename=str(registry_path),
        Bucket=bucket,
        Key=registry_key,
        ExtraArgs={
            "ContentType": "application/json",
            "CacheControl": "max-age=60, must-revalidate",
        },
    )
    uploaded += 1

    print(
        f"✓ uploaded {uploaded} object(s) to s3://{bucket}/{prefix}/",
        file=sys.stderr,
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument(
        "--apps-dir",
        type=Path,
        default=REPO_ROOT / "apps",
        help="Directory containing <slug>/manifest.json subfolders.",
    )
    p.add_argument(
        "--bucket", default=DEFAULT_BUCKET, help=f"R2 bucket (default: {DEFAULT_BUCKET})."
    )
    p.add_argument(
        "--prefix",
        default=DEFAULT_PREFIX,
        help=(
            f"Registry key prefix / build env (default: {DEFAULT_PREFIX!r}). "
            "Must match matrix-nexus' DEPLOY_ENV or PRESET_APPS_REGISTRY_KEY_PREFIX."
        ),
    )
    p.add_argument(
        "--env-file",
        type=Path,
        default=DEFAULT_ENV_FILE,
        help=(
            "Read R2_* credentials from this .env (default: "
            f"{DEFAULT_ENV_FILE}). Real env vars take precedence."
        ),
    )
    p.add_argument(
        "--account-id",
        default=None,
        help="Cloudflare R2 account id (overrides R2_ACCOUNT_ID).",
    )
    p.add_argument(
        "--access-key-id",
        default=None,
        help="R2 access key id (overrides R2_ACCESS_KEY_ID).",
    )
    p.add_argument(
        "--secret-access-key",
        default=None,
        help="R2 secret (overrides R2_SECRET_ACCESS_KEY).",
    )
    p.add_argument(
        "--endpoint-url",
        default=None,
        help=(
            "Custom S3 endpoint URL. Defaults to "
            "https://<ACCOUNT_ID>.r2.cloudflarestorage.com."
        ),
    )
    p.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Where to build artifacts. Default: ephemeral temp dir (auto-cleaned).",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Build the registry but skip the upload.",
    )
    args = p.parse_args(argv)

    file_env = _load_env_file(args.env_file)
    if args.env_file != DEFAULT_ENV_FILE and not file_env:
        print(f"warning: --env-file {args.env_file} not found / empty", file=sys.stderr)

    output_dir = args.output_dir
    temp_holder: tempfile.TemporaryDirectory[str] | None = None
    if output_dir is None:
        temp_holder = tempfile.TemporaryDirectory(prefix="preset-registry-local-")
        output_dir = Path(temp_holder.name)
    else:
        # Avoid mixing stale artifacts into a deterministic build.
        if output_dir.exists():
            shutil.rmtree(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

    try:
        t0 = time.monotonic()
        _build(
            apps_dir=args.apps_dir,
            prefix=args.prefix,
            source_sha=f"local-{int(time.time())}",
            output_dir=output_dir,
        )

        if args.dry_run:
            print(
                f"✓ dry-run: built registry under {output_dir} "
                f"({time.monotonic() - t0:.2f}s) — skipping upload",
                file=sys.stderr,
            )
            return 0

        account_id = _resolve_setting("R2_ACCOUNT_ID", cli_value=args.account_id, file_env=file_env)
        access_key = _resolve_setting(
            "R2_ACCESS_KEY_ID", cli_value=args.access_key_id, file_env=file_env
        )
        secret_key = _resolve_setting(
            "R2_SECRET_ACCESS_KEY", cli_value=args.secret_access_key, file_env=file_env
        )
        endpoint = (
            args.endpoint_url
            or os.environ.get("R2_ENDPOINT_URL")
            or file_env.get("R2_ENDPOINT_URL")
        )

        missing = [
            name
            for name, val in (
                ("R2_ACCESS_KEY_ID", access_key),
                ("R2_SECRET_ACCESS_KEY", secret_key),
            )
            if not val
        ]
        if not endpoint and not account_id:
            missing.append("R2_ACCOUNT_ID (or --endpoint-url)")
        if missing:
            raise SystemExit(
                "missing R2 credentials: " + ", ".join(missing) +
                f"\nLooked in env + {args.env_file}"
            )

        if not endpoint:
            endpoint = f"https://{account_id}.r2.cloudflarestorage.com"

        _upload(
            output_dir=output_dir,
            bucket=args.bucket,
            prefix=args.prefix,
            endpoint_url=endpoint,
            access_key_id=access_key,  # type: ignore[arg-type]
            secret_access_key=secret_key,  # type: ignore[arg-type]
        )

        print(
            f"✓ done in {time.monotonic() - t0:.2f}s — restart matrix-nexus "
            "to pick up the new registry",
            file=sys.stderr,
        )
        return 0
    finally:
        if temp_holder is not None:
            temp_holder.cleanup()


if __name__ == "__main__":
    raise SystemExit(main())
