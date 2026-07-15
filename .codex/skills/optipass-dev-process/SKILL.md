---
name: optipass-dev-process
description: Start, restart, stop, or inspect the Optipass local API and Angular development services with the required elevated shell permissions. Use for requests to start the Optipass background process, launch the local browser app, restart the development servers, stop Optipass services, or check whether ports 3417 and 4200 are available in /Users/bppleman/RustroverProjects/optipass.
---

# Optipass development process control

Use two long-lived elevated terminal sessions for startup. Do not launch these services through `nohup`, `&`, or a detached shell: the Codex terminal supervisor reaps detached children when the launcher exits. Keep both returned session IDs so they can be stopped with `write_stdin` later.

## Start or restart

First clean stale Optipass processes with the bundled stop command:

```bash
bash .codex/skills/optipass-dev-process/scripts/manage-optipass.sh stop
```

Run it with `sandbox_permissions: "require_escalated"`.

Then launch these two commands in parallel, each with `tty: true`, `yield_time_ms: 1000`, and `sandbox_permissions: "require_escalated"`:

```bash
# API session
pnpm run dev
# workdir: /Users/bppleman/RustroverProjects/optipass/apps/api

# Web session
pnpm exec ng serve --host 127.0.0.1
# workdir: /Users/bppleman/RustroverProjects/optipass/apps/web
```

Wait for the API log to say `Server listening at http://127.0.0.1:3417` and the Web log to say `Local: http://127.0.0.1:4200/`. Verify with `curl --max-time 5` against `http://127.0.0.1:3417/api/session` and `http://127.0.0.1:4200/`.

## Stop

If the API/Web session IDs are still available, send `Ctrl-C` to both sessions and poll them until they exit. Then run this cleanup command with `sandbox_permissions: "require_escalated"` to remove stale watchers and anything still listening on the dedicated ports:

```bash
bash .codex/skills/optipass-dev-process/scripts/manage-optipass.sh stop
```

The command is safe for unrelated Codex, Node, or browser processes: it targets only Optipass service commands and ports 3417/4200.

## Inspect status

```bash
bash .codex/skills/optipass-dev-process/scripts/manage-optipass.sh status
```

Run with elevation. It reports whether each dedicated port responds and exits nonzero unless both services are running.

## Fixed service contract

- API working directory: `/Users/bppleman/RustroverProjects/optipass/apps/api`
- API command: `pnpm run dev`
- API address: `http://127.0.0.1:3417`
- Web working directory: `/Users/bppleman/RustroverProjects/optipass/apps/web`
- Web command: `pnpm exec ng serve --host 127.0.0.1`
- Web address: `http://127.0.0.1:4200`
- API log: `/tmp/optipass-api.log` when using a separate log capture
- Web log: `/tmp/optipass-web.log` when using a separate log capture

