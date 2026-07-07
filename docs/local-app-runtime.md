# Local App Runtime

Optipass now has three explicit launch modes. The repository root is an orchestration layer, not a pnpm workspace. Each active sub-project keeps its own `package.json` and `pnpm-lock.yaml`; root-level commands are `just` recipes that call into those projects.

Active projects:

- `packages/core`: shared duplicate-detection and planning logic.
- `apps/api`: Node/Fastify API, 1Password SDK integration, local static UI serving for browser-serve, and the Tauri helper payload.
- `apps/web`: current Angular UI.
- `apps/tauri`: formal desktop app shell.
- `archived/web`: old UI kept for reference only.

## `browser-dev`

Use this for UI work.

```sh
just dev-browser
```

The API runs as a Node process on `127.0.0.1:3417`. The Angular dev server runs from `apps/web` and proxies `/api` plus `/healthz` to the API. Browser DevTools remains the primary debugging surface.

## `browser-serve`

Use this for a single local process that serves both the API and the production Angular build.

```sh
just serve-local
```

The launcher starts `apps/api`, serves `apps/web/dist/web/browser`, binds only to `127.0.0.1`, picks a random port by default, writes a runtime manifest under the OS temp directory, and can open the system browser.

## `tauri`

Use this mode for the desktop app.

```sh
just dev-tauri
```

Tauri owns the WebView and uses `apps/web` as its frontend. Rust starts the packaged API helper from `apps/tauri/resources/api` in development or `.app/Contents/Resources/api` after bundling. It prefers the bundled Bun runtime at `resources/runtime/bun/bun`, falls back to system Node.js only if that runtime is missing, reads the helper ready line, and exposes `{ baseUrl, token }` through the `backend_session` command. Angular then uses local HTTP for API traffic.

For a distributable desktop build:

```sh
just build-tauri
```

## Runtime Files

For Tauri builds, `apps/tauri/resources/api` maps to `.app/Contents/Resources/api`, and `apps/tauri/resources/runtime` maps to `.app/Contents/Resources/runtime`. The API and core projects still only run `tsc -> dist`; Tauri owns assembling installable production resources.

The local launcher owns a single-instance lock and manifest:

- `pid`
- `host`
- `port`
- `token`
- `mode`
- `startedAt`
- `url`

If the manifest points to a dead process, the next launcher clears it before acquiring the lock.

## API Lifecycle

- `GET /healthz` is public for local probes.
- `GET /api/session` is the browser bootstrap endpoint for the local session token and capabilities. In Tauri mode it requires `x-session-token`; the token is injected through Rust IPC instead.
- Other `/api/*` endpoints require `x-session-token`.
- `POST /api/session/heartbeat` refreshes idle lifetime.
- `POST /api/session/shutdown` is available only in launcher-managed modes and refuses to stop while scans or mutations are running.
