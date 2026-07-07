#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--" ]]; then
  shift
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tauri_dir="$(cd "$script_dir/.." && pwd)"
repo_root="$(cd "$tauri_dir/../.." && pwd)"
pack_dir="$tauri_dir/.pack/api-resource"
staging_repo="$pack_dir/repo"
staged_core="$staging_repo/packages/core"
staged_api="$staging_repo/apps/api"
resource_api="$tauri_dir/resources/api"

cleanup_pack() {
  rm -rf "$pack_dir"
  rmdir "$tauri_dir/.pack" 2>/dev/null || true
}

trap cleanup_pack EXIT

rm -rf "$pack_dir" "$resource_api"
mkdir -p "$staged_core" "$staged_api" "$tauri_dir/resources"

cp -R \
  "$repo_root/packages/core/package.json" \
  "$repo_root/packages/core/pnpm-lock.yaml" \
  "$repo_root/packages/core/dist" \
  "$staged_core/"

cp -R \
  "$repo_root/apps/api/package.json" \
  "$repo_root/apps/api/pnpm-lock.yaml" \
  "$repo_root/apps/api/dist" \
  "$staged_api/"

pnpm --dir "$staged_api" install \
  --prod \
  --frozen-lockfile \
  --node-linker=hoisted \
  --package-import-method=copy \
  "$@"

rm -rf "$staged_api/node_modules/.bin"
mv "$staged_api" "$resource_api"
