# Paperclip desktop app

A Tauri shell that runs the Paperclip server on the user's machine and shows its
board in a native window. Modeled on `unsloth-studio`'s shape: the native shell
owns the backend process, waits for it to become healthy, and only then reveals
the app.

What differs from unsloth-studio is what gets loaded. Paperclip's server serves
its own UI, so there is no second frontend to build or bundle — once
`/api/health` answers, the window navigates to the server origin and the rest is
the ordinary web app. The only bundled frontend is `ui/index.html`, a boot page
that carries startup status while the server comes up.

## Layout

| Path | What it is |
| --- | --- |
| `src-tauri/src/launch.rs` | Resolves how to start a server, picks the port, probes health |
| `src-tauri/src/server.rs` | Owns the child process: spawn, health gate, log pump, shutdown |
| `src-tauri/src/commands.rs` | `boot_info` / `restart_server` for the boot window |
| `src-tauri/src/lib.rs` | Window setup, startup sequencing, exit reaping |
| `ui/index.html` | Boot page; no bundler, uses the global Tauri bridge |
| `scripts/generate-icons.mjs` | Regenerates the icon set (`pnpm --dir desktop icons`) |

## Running it

```sh
# 1. Build a server for the shell to run (or point the shell at another one).
pnpm --filter @paperclipai/server build

# 2. Install the Tauri CLI and run the shell.
npm --prefix desktop install
npm --prefix desktop run dev
```

`desktop` is intentionally **not** a pnpm workspace member: the Tauri CLI is a
heavy platform-specific download that no other package needs, and keeping it out
means CI installs for the web app do not carry it.

## How the shell finds a server

Resolution walks from most explicit to most implicit, and a miss is a readable
error on the boot page rather than a crash:

1. `PAPERCLIP_DESKTOP_SERVER` — an argv string (quotes honored for paths with spaces).
2. `PAPERCLIP_DESKTOP_SERVER_ENTRY` — one path, run with `node` (`PAPERCLIP_DESKTOP_NODE` overrides the interpreter).
3. `server/dist/index.js` in a repository checkout, found from the working directory or from the executable's location.
4. `paperclipai` on `PATH`.

The shell binds the server to loopback only (`PAPERCLIP_BIND_HOST=127.0.0.1`) and
sets `PORT`, so a desktop install never exposes Paperclip on the LAN by accident.
`PAPERCLIP_DESKTOP_PORT` overrides the port; otherwise the first free port at or
above 3100 is used. If a server is already healthy on that port, the shell adopts
it instead of starting a second one against the same database.

## Process lifetime

The shell is the server's parent, so it also owns reaping it:

- Server stdout and stderr are drained into
  `<app-log-dir>/paperclip-server.log`. Draining matters: a full pipe buffer
  would block the server forever.
- Closing the window or quitting stops the child. On Windows the child is also
  assigned to a job object with `KILL_ON_JOB_CLOSE`, so killing the shell still
  kills the server.
- Startup is a health gate, not a sleep: the window stays hidden until
  `/api/health` answers, then navigates. A failed start leaves the boot page up
  with the error and a retry action.

## Verified

`cargo clippy`, `cargo test`, and a Windows NSIS bundle were run on this branch.
The supervisor was exercised end to end against a stub server: the child spawned
on the resolved port, the health gate requested `/api/health`, the webview loaded
the server origin, and the child was gone after the app exited.

Not verified: Linux and macOS bundles, and a real end-to-end run against a built
Paperclip server plus UI dist.