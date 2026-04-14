#!/usr/bin/env bash
# Build script for the Mintlayer Windows native app.
# Run from the repo root or from windows/ — works either way.
# Requirements: bun, npm, cargo, cargo-tauri, curl, unzip
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WINDOWS_DIR="$REPO_ROOT/windows"
BINARIES_DIR="$WINDOWS_DIR/src-tauri/binaries"
APP_DIR="$REPO_ROOT/app"

ML_VERSION="1.3.0"
ML_WIN_ZIP_URL="https://github.com/mintlayer/mintlayer-core/releases/download/v${ML_VERSION}/Mintlayer_Node_win_${ML_VERSION}.zip"
ML_WIN_ZIP="/tmp/ml_win_${ML_VERSION}.zip"

TAURI_TRIPLE="x86_64-pc-windows-msvc"

echo "==> Creating binaries directory"
mkdir -p "$BINARIES_DIR"

# ── Step 1: Download Mintlayer Windows binaries ────────────────────────────────
echo "==> Downloading Mintlayer Windows binaries v${ML_VERSION}"
if [ ! -f "$ML_WIN_ZIP" ]; then
  curl -fSL "$ML_WIN_ZIP_URL" -o "$ML_WIN_ZIP"
else
  echo "    (cached at $ML_WIN_ZIP)"
fi

echo "==> Extracting binaries"
EXTRACT_DIR="/tmp/ml_win_extract_${ML_VERSION}"
rm -rf "$EXTRACT_DIR"
unzip -q "$ML_WIN_ZIP" -d "$EXTRACT_DIR"

# Rename to Tauri sidecar naming convention: <name>-<triple>.exe
for EXE in node-daemon wallet-rpc-daemon api-blockchain-scanner-daemon api-web-server; do
  SRC="$EXTRACT_DIR/Mintlayer_Node_win_${ML_VERSION}/${EXE}.exe"
  DST="$BINARIES_DIR/${EXE}-${TAURI_TRIPLE}.exe"
  if [ -f "$SRC" ]; then
    cp "$SRC" "$DST"
    echo "    copied ${EXE}.exe → $(basename "$DST")"
  else
    echo "    WARNING: $SRC not found — skipping"
  fi
done

# ── Step 2: Build Astro app ────────────────────────────────────────────────────
echo "==> Building Astro app"
cd "$APP_DIR"
npm ci --silent
npm run build

# ── Step 3: Cross-compile web-gui.exe with Bun ────────────────────────────────
echo "==> Compiling web-gui.exe (cross-compile: bun-windows-x64)"
if ! command -v bun &>/dev/null; then
  echo "    Bun not found — installing via official installer"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
bun build \
  --compile \
  --target=bun-windows-x64 \
  --minify \
  --outfile "$BINARIES_DIR/web-gui-${TAURI_TRIPLE}.exe" \
  "$APP_DIR/dist/server/entry.mjs"

# ── Step 4: Copy wasm-wrappers ────────────────────────────────────────────────
echo "==> Copying wasm-wrappers"
WASM_DST="$WINDOWS_DIR/src-tauri/binaries/wasm-wrappers"
rm -rf "$WASM_DST"
cp -r "$APP_DIR/wasm-wrappers" "$WASM_DST"

# ── Step 5: Download PostgreSQL portable (Windows) ────────────────────────────
PG_VERSION="17.4-1"
PG_ZIP_URL="https://get.enterprisedb.com/postgresql/postgresql-${PG_VERSION}-windows-x64-binaries.zip"
PG_ZIP="/tmp/postgresql_win_${PG_VERSION}.zip"
PG_DST="$WINDOWS_DIR/src-tauri/binaries/postgres"

if [ ! -d "$PG_DST/bin" ]; then
  echo "==> Downloading PostgreSQL ${PG_VERSION} portable"
  if [ ! -f "$PG_ZIP" ]; then
    curl -fSL "$PG_ZIP_URL" -o "$PG_ZIP"
  else
    echo "    (cached at $PG_ZIP)"
  fi
  echo "==> Extracting PostgreSQL (this may take a minute)"
  PG_EXTRACT="/tmp/pg_win_extract_${PG_VERSION}"
  rm -rf "$PG_EXTRACT"
  unzip -q "$PG_ZIP" -d "$PG_EXTRACT"
  mkdir -p "$PG_DST"
  # Only copy what we need: bin/, lib/, share/
  cp -r "$PG_EXTRACT/pgsql/bin" "$PG_DST/"
  cp -r "$PG_EXTRACT/pgsql/lib" "$PG_DST/"
  cp -r "$PG_EXTRACT/pgsql/share" "$PG_DST/"
  echo "    PostgreSQL copied to $(du -sh "$PG_DST" | cut -f1)"
else
  echo "==> PostgreSQL already extracted, skipping"
fi

# ── Step 6: Build Tauri app (.msi) ────────────────────────────────────────────
if [[ "$(uname)" != "MINGW"* && "$(uname)" != "MSYS"* && "$OSTYPE" != "msys" && "$(uname)" != "Windows_NT" ]]; then
  echo ""
  echo "==> Skipping Tauri installer build (not running on Windows)"
  echo "    The .msi requires the Windows SDK — run via GitHub Actions:"
  echo "    gh workflow run windows-build.yml"
  echo ""
  echo "    Steps completed:"
  echo "      ✓ Mintlayer binaries → windows/src-tauri/binaries/"
  echo "      ✓ web-gui.exe compiled"
  echo "      ✓ wasm-wrappers copied"
  echo "      ✓ PostgreSQL portable extracted"
  echo ""
  echo "    Push a tag to trigger a full release build:"
  echo "    git tag v1.0.0 && git push origin v1.0.0"
  exit 0
fi

echo "==> Building Tauri installer"
if ! cargo tauri --version &>/dev/null 2>&1; then
  echo "    cargo-tauri not found — installing"
  cargo install tauri-cli --version "^2" --locked
fi
cd "$WINDOWS_DIR"
cargo tauri build --target "$TAURI_TRIPLE"

echo ""
echo "Done! Installer is at:"
find "$WINDOWS_DIR/src-tauri/target/$TAURI_TRIPLE/release/bundle" \
  \( -name "*.msi" -o -name "*.exe" \) 2>/dev/null | grep -v "\.cargo"
