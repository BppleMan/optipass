# Optipass Tauri App

This is the formal desktop shell. It owns the WebView and packages the Angular UI from `apps/web`.

The API is not an executable sidecar. It is packaged as a generated resource directory at `resources/api`, copied to `.app/Contents/Resources/api`, and started by the Rust main process with the bundled Bun runtime from `resources/runtime/bun/bun`. A system Node.js runtime remains a development fallback if the bundled runtime is missing.

## Development

```bash
just dev-tauri
```

The Tauri dev server loads `apps/web` from Angular's dev server. Rust starts the packaged API helper with the bundled runtime and exposes its local HTTP session to Angular through the `backend_session` command.

## Build

```bash
just build-tauri
```

The build flow compiles core, compiles the API helper, builds the Angular UI, then prepares API resources plus the Bun runtime in `beforeBuildCommand` so Tauri's Rust build script can validate bundle resource paths before packaging.
