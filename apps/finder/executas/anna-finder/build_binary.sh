#!/usr/bin/env bash
# ============================================================
# tool-anna-finder — local single-platform binary build
# ============================================================
# Mirrors the per-platform step in
#   .github/workflows/release-anna-finder.yml
# so you can reproduce a release artifact locally before tagging.
#
# Usage (from this directory):
#   ./build_binary.sh           # build + smoke-test describe
#   ./build_binary.sh --test    # alias: same as default
#   ./build_binary.sh --clean   # also wipe build/ dist/ *.spec first
#
# Output:
#   dist/tool-anna-finder                         # raw single-file binary
#   dist/tool-anna-finder-<platform>.tar.gz|zip   # release-shaped archive
# ============================================================

set -euo pipefail

cd "$(dirname "$0")"

CLEAN=false
SMOKE=true
for arg in "$@"; do
    case "$arg" in
        --clean) CLEAN=true ;;
        --no-test) SMOKE=false ;;
        --test) SMOKE=true ;;
        -h|--help)
            sed -n '2,18p' "$0"
            exit 0
            ;;
        *) echo "Unknown flag: $arg" >&2; exit 2 ;;
    esac
done

if $CLEAN; then
    rm -rf build dist *.spec
fi

# ── Detect platform key (matches Anna's get_platform_key) ────
uname_s=$(uname -s)
uname_m=$(uname -m)
case "$uname_s" in
    Darwin)  os=darwin  ;;
    Linux)   os=linux   ;;
    MINGW*|MSYS*|CYGWIN*) os=windows ;;
    *)       os="$(echo "$uname_s" | tr '[:upper:]' '[:lower:]')" ;;
esac
case "$uname_m" in
    x86_64|amd64) arch=x86_64 ;;
    arm64|aarch64) arch=$([[ "$os" == "darwin" ]] && echo arm64 || echo aarch64) ;;
    *) arch="$uname_m" ;;
esac
PLATFORM="${os}-${arch}"
EXT=$([[ "$os" == "windows" ]] && echo .exe || echo "")
ARCHIVE_EXT=$([[ "$os" == "windows" ]] && echo zip || echo tar.gz)

echo "→ Platform: $PLATFORM"

# ── Ensure PyInstaller is available ──────────────────────────
if ! python3 -c "import PyInstaller" 2>/dev/null; then
    echo "→ Installing PyInstaller…"
    python3 -m pip install --quiet pyinstaller
fi

# ── Build ─────────────────────────────────────────────────────
echo "→ pyinstaller --onefile…"
python3 -m PyInstaller \
    --onefile \
    --name "tool-anna-finder${EXT}" \
    --clean \
    --noupx \
    anna_finder_plugin.py

BIN="dist/tool-anna-finder${EXT}"
[[ -x "$BIN" ]] || { echo "❌ build failed: $BIN missing" >&2; exit 1; }

# ── Smoke test ────────────────────────────────────────────────
if $SMOKE; then
    echo "→ describe smoke test…"
    echo '{"jsonrpc":"2.0","id":1,"method":"describe"}' \
        | "$BIN" \
        | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['result']['name']=='tool-anna-finder', d; print('✅ describe OK')"
fi

# ── Package release-shaped archive ───────────────────────────
ASSET="tool-anna-finder-${PLATFORM}.${ARCHIVE_EXT}"
( cd dist && \
    if [[ "$ARCHIVE_EXT" == "zip" ]]; then
        rm -f "$ASSET"
        zip -q "$ASSET" "tool-anna-finder${EXT}"
    else
        tar czf "$ASSET" "tool-anna-finder"
    fi
    shasum -a 256 "$ASSET" | tee "$ASSET.sha256"
)

echo
echo "✅ Built: dist/$ASSET"
