#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--" ]]; then
  shift
fi

BUN_VERSION="bun-v1.3.14"
BUN_ASSET="bun-darwin-aarch64.zip"
BUN_SHA256="d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620"
BUN_BINARY_SHA256="e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233"
BUN_VERSION_NUMBER="${BUN_VERSION#bun-v}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tauri_dir="$(cd "$script_dir/.." && pwd)"
pack_dir="$tauri_dir/.pack/bun-runtime"
resource_dir="$tauri_dir/resources/runtime/bun"
resource_bun="$resource_dir/bun"
archive="$pack_dir/$BUN_ASSET"
extract_dir="$pack_dir/extract"
download_url="https://github.com/oven-sh/bun/releases/download/$BUN_VERSION/$BUN_ASSET"

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

if [[ -x "$resource_bun" ]]; then
  actual_resource_sha256="$(sha256_file "$resource_bun")"
  actual_version="$("$resource_bun" --version)"
  if [[ "$actual_resource_sha256" == "$BUN_BINARY_SHA256" && "$actual_version" == "$BUN_VERSION_NUMBER" ]]; then
    echo "$actual_version"
    exit 0
  fi
  echo "Bundled Bun runtime is stale or invalid; refreshing $resource_bun." >&2
fi

cleanup() {
  rm -rf "$pack_dir"
  rmdir "$tauri_dir/.pack" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

rm -rf "$pack_dir"
mkdir -p "$pack_dir"

curl -fsSL "$download_url" -o "$archive"
actual_sha256="$(sha256_file "$archive")"
if [[ "$actual_sha256" != "$BUN_SHA256" ]]; then
  echo "Bun runtime checksum mismatch: expected $BUN_SHA256, got $actual_sha256" >&2
  exit 1
fi

unzip -q "$archive" -d "$extract_dir"
bun_binary="$(find "$extract_dir" -type f -name bun | head -n 1)"
if [[ -z "$bun_binary" ]]; then
  echo "Cannot find bun binary in $BUN_ASSET" >&2
  exit 1
fi

actual_binary_sha256="$(sha256_file "$bun_binary")"
if [[ "$actual_binary_sha256" != "$BUN_BINARY_SHA256" ]]; then
  echo "Bun binary checksum mismatch: expected $BUN_BINARY_SHA256, got $actual_binary_sha256" >&2
  exit 1
fi

rm -rf "$resource_dir"
mkdir -p "$resource_dir"
cp "$bun_binary" "$resource_bun"
chmod +x "$resource_bun"

"$resource_bun" --version
