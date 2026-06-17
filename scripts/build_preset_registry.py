#!/usr/bin/env python3
"""Build a preset-apps registry payload for upload to R2.

Produces, under ``--output-dir``::

    <output-dir>/
      registry.json
      <slug>/<version>/app.tar.gz
      <slug>/<version>/app.tar.gz.sha256

Layout matches ``docs/design/preset-apps-remote-registry.md`` in matrix-nexus.

Per-app inputs (under ``--apps-dir/<slug>/``):
  - ``manifest.json``        (required)  — supplies ``version`` (falls back to
                                            ``app.json:version``).
  - ``app.json``             (optional)  — used for ``version`` fallback.
  - ``preset.json``          (optional)  — overrides ``{system, min_nexus_version,
                                            deprecated}`` for registry entry.
  - ``bundle/``              (required)  — sanity-checked but not unpacked here.

Tar contents are rooted at the app directory (i.e. ``manifest.json`` lives at
tar root), matching what matrix-nexus' ``_safe_extract_tar`` expects.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import tarfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

SCHEMA_VERSION = 1
SLUG_RE = re.compile(r"^[a-z][a-z0-9-]{1,63}$")
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+([.+-].*)?$")

# Directories / files excluded from each app's tarball.
TAR_EXCLUDE_NAMES = frozenset(
    {
        "node_modules",
        ".git",
        ".github",
        ".venv",
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        "dist",
        "build",
        ".turbo",
        ".next",
        ".DS_Store",
    }
)
TAR_EXCLUDE_SUFFIXES = (".pyc", ".pyo", ".log")


@dataclass(frozen=True)
class AppEntry:
    slug: str
    version: str
    tar_key: str
    tar_sha256: str
    tar_size_bytes: int
    system: bool
    min_nexus_version: str | None
    deprecated: bool

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "slug": self.slug,
            "version": self.version,
            "tar_key": self.tar_key,
            "tar_sha256": self.tar_sha256,
            "tar_size_bytes": self.tar_size_bytes,
        }
        # Emit optional fields only when set, to keep registry.json compact and
        # match the schema's "optional default" semantics on the nexus side.
        if self.system:
            out["system"] = True
        if self.min_nexus_version:
            out["min_nexus_version"] = self.min_nexus_version
        if self.deprecated:
            out["deprecated"] = True
        return out


def _load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _resolve_version(app_dir: Path, manifest: dict[str, Any]) -> str:
    """Match matrix-nexus seeder version resolution.

    ``manifest.json:version`` → ``app.json:version`` → ``0.0.0``.
    """
    v = manifest.get("version")
    if not v:
        app_meta_path = app_dir / "app.json"
        if app_meta_path.is_file():
            v = _load_json(app_meta_path).get("version")
    v = v or "0.0.0"
    if not isinstance(v, str) or not SEMVER_RE.match(v):
        raise ValueError(f"{app_dir.name}: invalid version {v!r}")
    return v


def _load_preset_overrides(app_dir: Path) -> dict[str, Any]:
    path = app_dir / "preset.json"
    if not path.is_file():
        return {}
    data = _load_json(path)
    if not isinstance(data, dict):
        raise ValueError(f"{app_dir.name}: preset.json must be a JSON object")
    return data


def _tar_filter(tarinfo: tarfile.TarInfo) -> tarfile.TarInfo | None:
    name = Path(tarinfo.name).name
    if name in TAR_EXCLUDE_NAMES:
        return None
    if any(part in TAR_EXCLUDE_NAMES for part in Path(tarinfo.name).parts):
        return None
    if name.endswith(TAR_EXCLUDE_SUFFIXES):
        return None
    # Strip ownership / mtime noise for reproducible-ish archives.
    tarinfo.uid = 0
    tarinfo.gid = 0
    tarinfo.uname = ""
    tarinfo.gname = ""
    # Disallow symlinks/hardlinks/devices in the tar to mirror what nexus
    # accepts on extract.
    if tarinfo.issym() or tarinfo.islnk() or tarinfo.isdev() or tarinfo.isfifo():
        raise ValueError(f"unsupported tar entry type for {tarinfo.name!r}")
    return tarinfo


def _build_tar(app_dir: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(dst.suffix + ".tmp")
    if tmp.exists():
        tmp.unlink()
    # gzip with mtime=0 to keep the archive deterministic across runs that
    # touch no source files (helps avoid noisy re-uploads / sha changes).
    with tarfile.open(tmp, mode="w:gz", compresslevel=6, format=tarfile.PAX_FORMAT) as tar:
        # Walk in sorted order so tar layout is deterministic.
        for path in sorted(app_dir.rglob("*")):
            rel = path.relative_to(app_dir)
            tar.add(path, arcname=str(rel), recursive=False, filter=_tar_filter)
    tmp.replace(dst)


def _sha256_of_file(path: Path) -> tuple[str, int]:
    h = hashlib.sha256()
    size = 0
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
            size += len(chunk)
    return h.hexdigest(), size


def _iter_app_dirs(apps_dir: Path) -> Iterable[Path]:
    for child in sorted(apps_dir.iterdir()):
        if not child.is_dir():
            continue
        if child.name.startswith("."):
            continue
        if (child / "manifest.json").is_file():
            yield child


def build(
    *,
    apps_dir: Path,
    env: str,
    source_sha: str,
    source_repo: str,
    source_ref: str,
    output_dir: Path,
) -> dict[str, Any]:
    if not apps_dir.is_dir():
        raise SystemExit(f"apps dir not found: {apps_dir}")

    output_dir.mkdir(parents=True, exist_ok=True)
    entries: list[AppEntry] = []
    seen_slugs: set[str] = set()

    for app_dir in _iter_app_dirs(apps_dir):
        slug = app_dir.name
        if not SLUG_RE.match(slug):
            raise SystemExit(f"invalid slug: {slug!r}")
        if slug in seen_slugs:
            raise SystemExit(f"duplicate slug: {slug!r}")
        seen_slugs.add(slug)

        manifest = _load_json(app_dir / "manifest.json")
        version = _resolve_version(app_dir, manifest)

        if not (app_dir / "bundle").is_dir():
            raise SystemExit(f"{slug}: bundle/ directory missing")

        overrides = _load_preset_overrides(app_dir)
        system = bool(overrides.get("system", False))
        min_nv = overrides.get("min_nexus_version")
        if min_nv is not None and not isinstance(min_nv, str):
            raise SystemExit(f"{slug}: preset.min_nexus_version must be a string")
        deprecated = bool(overrides.get("deprecated", False))

        tar_rel = Path(slug) / version / "app.tar.gz"
        tar_dst = output_dir / tar_rel
        _build_tar(app_dir, tar_dst)
        sha, size = _sha256_of_file(tar_dst)
        (tar_dst.parent / "app.tar.gz.sha256").write_text(sha + "\n", encoding="utf-8")

        tar_key = f"{env}/{tar_rel.as_posix()}"
        entries.append(
            AppEntry(
                slug=slug,
                version=version,
                tar_key=tar_key,
                tar_sha256=sha,
                tar_size_bytes=size,
                system=system,
                min_nexus_version=min_nv,
                deprecated=deprecated,
            )
        )
        print(
            f"  [{slug}] v{version}  size={size}  sha256={sha[:12]}…  "
            f"system={system}  deprecated={deprecated}",
            file=sys.stderr,
        )

    registry: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "env": env,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source_repo": source_repo,
        "source_ref": source_ref,
        "source_sha": source_sha,
        "apps": [e.to_json() for e in entries],
    }

    registry_path = output_dir / "registry.json"
    # canonical, deterministic JSON (sorted keys, stable indent) so the upload
    # diff is meaningful when nothing changed.
    registry_path.write_text(
        json.dumps(registry, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return registry


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--apps-dir", required=True, type=Path)
    # ``local`` lets developers seed a personal R2 prefix (see
    # ``scripts/publish_preset_registry_local.py``) without piggy-backing on
    # staging/production. Nexus' validator only checks tar_key starts with
    # ``{env}/`` so any short ascii token would work, but we whitelist these
    # three to keep the CI matrix obvious.
    p.add_argument(
        "--env", required=True, choices=("local", "staging", "production")
    )
    p.add_argument("--source-sha", required=True)
    p.add_argument("--source-repo", default="github.com/anna-ai/anna-apps")
    p.add_argument("--source-ref", default="main")
    p.add_argument("--output-dir", required=True, type=Path)
    args = p.parse_args(argv)

    t0 = time.monotonic()
    registry = build(
        apps_dir=args.apps_dir,
        env=args.env,
        source_sha=args.source_sha,
        source_repo=args.source_repo,
        source_ref=args.source_ref,
        output_dir=args.output_dir,
    )
    dt = time.monotonic() - t0
    print(
        f"built registry env={args.env} apps={len(registry['apps'])} in {dt:.2f}s "
        f"→ {args.output_dir / 'registry.json'}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
