set shell := ["bash", "-cu"]

# 基础入口

default:
    @just --list

# 项目准备与资产生成

install:
    pnpm --dir packages/core install
    pnpm --dir apps/api install
    pnpm --dir apps/web install
    pnpm --dir apps/tauri install

icons:
    #!/usr/bin/env bash
    set -euo pipefail
    tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/optipass-icons.XXXXXX")"
    cleanup() {
      rm -rf "$tmpdir"
    }
    trap cleanup EXIT INT TERM

    rm -rf apps/tauri/icons apps/web/public/brand
    mkdir -p apps/web/public/brand
    dock_source="$tmpdir/Icon-dock-square.svg"
    sed '1s|width="142" height="141" viewBox="0 0 142 141"|width="142" height="142" viewBox="0 0 142 142"|' logo/Icon-dock.svg > "$dock_source"

    pnpm --dir apps/tauri tauri icon "$dock_source" --output icons
    pnpm --dir apps/tauri tauri icon "$dock_source" --output "$tmpdir/web-default"
    pnpm --dir apps/tauri tauri icon "$dock_source" --output "$tmpdir/web" --png 180 --png 192 --png 512
    pnpm --dir apps/tauri tauri icon ../../logo/Icon-light.svg --output "$tmpdir/light" --png 128 --png 256 --png 512

    cp "$dock_source" apps/web/public/favicon.svg
    cp "$dock_source" apps/web/public/brand/optipass-dock.svg
    cp logo/Icon-light.svg apps/web/public/brand/optipass-icon.svg
    cp logo/text-icon.svg apps/web/public/brand/optipass-text.svg
    cp "$tmpdir/web-default/icon.ico" apps/web/public/favicon.ico
    cp "$tmpdir/web/180x180.png" apps/web/public/apple-touch-icon.png
    cp "$tmpdir/web/192x192.png" apps/web/public/icon-192.png
    cp "$tmpdir/web/512x512.png" apps/web/public/icon-512.png
    cp "$tmpdir/light/128x128.png" apps/web/public/brand/optipass-icon-128.png
    cp "$tmpdir/light/256x256.png" apps/web/public/brand/optipass-icon-256.png
    cp "$tmpdir/light/512x512.png" apps/web/public/brand/optipass-icon-512.png

# 构建与打包

build-core:
    pnpm --dir packages/core build

build-api: build-core
    pnpm --dir apps/api build

build-ui: build-core
    CI=true pnpm --dir apps/web build

build-local: build-core build-ui build-api

package-tauri-api: build-api
    cd apps/tauri && CI=true pnpm run prepare:api-resource

package-tauri-resources: build-api
    cd apps/tauri && CI=true pnpm run prepare:resources

# 本地开发与运行

dev-api: build-core
    cd apps/api && pnpm dev

dev-ui:
    cd apps/web && pnpm exec ng serve --host 127.0.0.1 --port 4200

dev-browser:
    #!/usr/bin/env bash
    set -euo pipefail
    just build-core
    pids=()
    cleanup() {
      for pid in "${pids[@]:-}"; do
        kill "$pid" 2>/dev/null || true
      done
    }
    trap cleanup EXIT INT TERM
    (cd apps/api && pnpm dev) &
    pids+=("$!")
    (cd apps/web && pnpm exec ng serve --host 127.0.0.1 --port 4200) &
    pids+=("$!")
    wait

serve-local: build-local
    cd apps/api && APP_MODE=browser-serve pnpm serve:local

dev-tauri: package-tauri-resources
    cd apps/tauri && pnpm tauri dev

# 构建与打包

build-tauri:
    cd apps/tauri && CI=true pnpm tauri build

# 验证与检查

test-core: build-core
    pnpm --dir packages/core test

test-api: build-core
    pnpm --dir apps/api test

test-ui: build-core
    CI=true pnpm --dir apps/web test

test-tauri:
    cd apps/tauri && cargo test

test: test-core test-api test-ui test-tauri

typecheck-core: build-core
    pnpm --dir packages/core typecheck

typecheck-api: build-core
    pnpm --dir apps/api typecheck

typecheck-ui: build-core
    CI=true pnpm --dir apps/web build

typecheck-tauri:
    cd apps/tauri && cargo check

typecheck: typecheck-core typecheck-api typecheck-ui typecheck-tauri

smoke-mock: build-local
    node scripts/smoke-mock.mjs
