#!/usr/bin/env python3
"""Verify every first-party executa's binary_urls are present on R2.

Used as a gate inside ``.github/workflows/publish-preset-registry.yml``:
the registry MUST NOT reference an executa version whose binary tarball
isn't yet on R2, otherwise matrix Agent's first install of the related
Anna App fails with HTTP 404 and the user sees ``Plugin not found``.

Behavior:
  * Walks ``apps/*/executas/*/pyproject.toml`` (path configurable).
  * For each ``[tool.anna.executa].binary_urls`` URL pointing at the
    canonical ``https://bin.anna.partners/<env>/executas/<tool>/<v>/<asset>``
    layout, derives the R2 (bucket, key) and ``HeadObject``s it.
  * Optional ``--sidecar`` flag also checks the ``<asset>.sha256``
    sidecar so partial uploads are caught early.
  * Exits 0 only if every expected object is reachable. Missing or
    unauthorized objects are reported together at the end.

Non-canonical URLs (e.g. GitHub Release mirrors, third-party hosts)
are skipped with a warning — we can only gate what we can resolve to
an R2 key.

Credentials: same as ``publish-preset-registry.yml`` — read from env
``R2_ACCOUNT_ID`` / ``R2_ACCESS_KEY_ID`` / ``R2_SECRET_ACCESS_KEY``.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_APPS_DIR = REPO_ROOT / "apps"
DEFAULT_BUCKET = "anna-preset-apps"

# Match the canonical public URL the seeder consumes. Captures:
#   1: env (e.g. "production", "staging", "local")
#   2: tool_id
#   3: version
#   4: asset filename (<platform>.<ext>)
_URL_RE = re.compile(
    r"^https?://bin\.anna\.partners/"
    r"(?P<env>[^/]+)/executas/"
    r"(?P<tool_id>[^/]+)/"
    r"(?P<version>[^/]+)/"
    r"(?P<asset>[^/]+)$"
)


@dataclass(frozen=True)
class _Expected:
    pyproject: Path
    platform: str
    url: str
    key: str  # R2 object key under the bucket


def _iter_pyprojects(apps_dir: Path) -> Iterable[Path]:
    if not apps_dir.is_dir():
        raise SystemExit(f"apps dir not found: {apps_dir}")
    yield from sorted(apps_dir.glob("*/executas/*/pyproject.toml"))


def _collect(apps_dir: Path) -> tuple[list[_Expected], list[str]]:
    expected: list[_Expected] = []
    warnings: list[str] = []
    for pyproject in _iter_pyprojects(apps_dir):
        try:
            data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001 - keep going, report all
            warnings.append(f"{pyproject}: failed to parse ({exc})")
            continue
        anna = (data.get("tool") or {}).get("anna", {}).get("executa", {})
        if (anna.get("distribution") or "").lower() != "binary":
            continue
        urls = anna.get("binary_urls") or {}
        if not isinstance(urls, dict) or not urls:
            warnings.append(f"{pyproject}: distribution=binary but no binary_urls")
            continue
        for platform, url in urls.items():
            if not isinstance(url, str):
                warnings.append(
                    f"{pyproject}::{platform}: non-string binary_urls value, skipped"
                )
                continue
            m = _URL_RE.match(url)
            if not m:
                warnings.append(
                    f"{pyproject}::{platform}: non-canonical URL skipped ({url})"
                )
                continue
            key = (
                f"{m['env']}/executas/{m['tool_id']}/"
                f"{m['version']}/{m['asset']}"
            )
            expected.append(
                _Expected(pyproject=pyproject, platform=platform, url=url, key=key)
            )
    return expected, warnings


def _check(
    expected: list[_Expected],
    *,
    bucket: str,
    endpoint_url: str,
    access_key_id: str,
    secret_access_key: str,
    include_sidecar: bool,
) -> list[str]:
    try:
        import boto3  # type: ignore[import-not-found]
        from botocore.config import Config  # type: ignore[import-not-found]
        from botocore.exceptions import ClientError  # type: ignore[import-not-found]
    except ImportError as exc:
        raise SystemExit(
            "boto3 is required. `pip install boto3` (already in CI)."
        ) from exc

    s3 = boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        region_name="auto",
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )

    failures: list[str] = []
    # Deduplicate keys — two apps may legitimately point at the same
    # executa version (shared first-party tool).
    seen_keys: set[str] = set()
    for item in expected:
        keys_to_check = [item.key]
        if include_sidecar:
            keys_to_check.append(f"{item.key}.sha256")
        for k in keys_to_check:
            if k in seen_keys:
                continue
            seen_keys.add(k)
            try:
                s3.head_object(Bucket=bucket, Key=k)
                print(f"  ✓ s3://{bucket}/{k}", file=sys.stderr)
            except ClientError as exc:
                code = exc.response.get("Error", {}).get("Code", "?")
                failures.append(
                    f"MISSING s3://{bucket}/{k}  ({code})  "
                    f"required by {item.pyproject}::{item.platform}"
                )
    return failures


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--apps-dir", type=Path, default=DEFAULT_APPS_DIR)
    p.add_argument("--bucket", default=DEFAULT_BUCKET)
    p.add_argument(
        "--endpoint-url",
        default=os.environ.get("AWS_ENDPOINT_URL", ""),
        help="R2 S3 endpoint, e.g. https://<acct>.r2.cloudflarestorage.com",
    )
    p.add_argument(
        "--account-id",
        default=os.environ.get("R2_ACCOUNT_ID", ""),
        help="Used to derive endpoint if --endpoint-url omitted.",
    )
    p.add_argument(
        "--sidecar",
        action="store_true",
        help="Also HEAD the <asset>.sha256 companion file.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print expected keys; skip the HeadObject calls (offline preflight).",
    )
    args = p.parse_args(argv)

    expected, warnings = _collect(args.apps_dir)
    for w in warnings:
        print(f"⚠ {w}", file=sys.stderr)

    if not expected:
        print(
            "no first-party executas with canonical bin.anna.partners URLs found "
            "— nothing to gate.",
            file=sys.stderr,
        )
        return 0

    print(
        f"checking {len(expected)} executa asset(s) on R2 "
        f"({'+sidecar' if args.sidecar else 'tarballs only'}) …",
        file=sys.stderr,
    )

    if args.dry_run:
        for e in expected:
            print(f"  · s3://{args.bucket}/{e.key}", file=sys.stderr)
        return 0

    endpoint = args.endpoint_url
    if not endpoint:
        if not args.account_id:
            raise SystemExit(
                "must supply --endpoint-url or --account-id (or R2_ACCOUNT_ID env)"
            )
        endpoint = f"https://{args.account_id}.r2.cloudflarestorage.com"

    access_key = os.environ.get("AWS_ACCESS_KEY_ID") or os.environ.get(
        "R2_ACCESS_KEY_ID", ""
    )
    secret_key = os.environ.get("AWS_SECRET_ACCESS_KEY") or os.environ.get(
        "R2_SECRET_ACCESS_KEY", ""
    )
    if not access_key or not secret_key:
        raise SystemExit(
            "missing R2 credentials (set R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY "
            "or AWS_* equivalents)"
        )

    failures = _check(
        expected,
        bucket=args.bucket,
        endpoint_url=endpoint,
        access_key_id=access_key,
        secret_access_key=secret_key,
        include_sidecar=args.sidecar,
    )

    if failures:
        print("", file=sys.stderr)
        print(f"❌ {len(failures)} missing executa asset(s):", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        print(
            "\nFix: tag the missing executa(s) "
            "(e.g. `git tag tool-anna-finder-v<X.Y.Z> && git push --tags`) "
            "and wait for `release-executa.yml` "
            "to finish uploading before re-running registry publish.",
            file=sys.stderr,
        )
        return 1

    print(f"✓ all {len(expected)} executa asset(s) present on R2", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
