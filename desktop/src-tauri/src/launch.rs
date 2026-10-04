//! Where the desktop shell looks for a Paperclip server, and how it picks a port.
//!
//! A packaged desktop build cannot assume a source checkout, and a developer
//! running `tauri dev` does not want a stale global install either. Resolution
//! therefore walks from most explicit to most implicit:
//!
//! 1. `PAPERCLIP_DESKTOP_SERVER` — an argv string, split on whitespace. The
//!    escape hatch for anything unusual, including a bundled sidecar.
//! 2. `PAPERCLIP_DESKTOP_SERVER_ENTRY` — a single path to a server entrypoint,
//!    run with the current executable's Node. Convenient when the path has
//!    spaces.
//! 3. `PAPERCLIP_DESKTOP_REPO` (or a `desktop/` sibling of the running
//!    executable during development) — `server/dist/index.js`, run with Node.
//! 4. `paperclipai` on `PATH`.
//!
//! A missing server is a configuration error, not a crash: the boot window
//! stays up and reports what it looked for.

use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub const DEFAULT_PORT: u16 = 3100;

/// Extra ports the shell will try, in order, before giving up on a fixed one.
const PORT_ATTEMPTS: u16 = 20;

#[derive(Debug, Clone)]
pub struct ServerLaunch {
    pub program: OsString,
    pub args: Vec<OsString>,
    /// Human-readable description of how the command was resolved, shown in the
    /// boot window's diagnostics when startup fails.
    pub source: String,
}

/// Split an argv string on whitespace, honoring double quotes so a path with
/// spaces survives. Backslash escapes apply outside quotes only — inside them a
/// backslash is a literal path separator on Windows, which is exactly the case
/// this needs to get right.
fn split_argv(raw: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut escaped = false;
    for ch in raw.chars() {
        match (escaped, in_quotes, ch) {
            (true, _, c) => {
                current.push(c);
                escaped = false;
            }
            (false, true, '"') => in_quotes = false,
            (false, false, '"') => in_quotes = true,
            (false, false, '\\') => escaped = true,
            (false, _, ' ') | (false, _, '\t') if !in_quotes => {
                if !current.is_empty() {
                    parts.push(std::mem::take(&mut current));
                }
            }
            (_, _, c) => current.push(c),
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

fn node_program() -> OsString {
    env::var_os("PAPERCLIP_DESKTOP_NODE").unwrap_or_else(|| OsString::from("node"))
}

/// Walk up from `start` looking for a repo root that contains `server/package.json`.
fn repo_root_from(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    while let Some(dir) = current {
        if dir.join("server").join("package.json").is_file() {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}

fn repo_candidates() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(explicit) = env::var_os("PAPERCLIP_DESKTOP_REPO") {
        roots.push(PathBuf::from(explicit));
    }
    if let Ok(cwd) = env::current_dir() {
        if let Some(root) = repo_root_from(&cwd) {
            roots.push(root);
        }
    }
    if let Ok(exe) = env::current_exe() {
        // dev builds live under desktop/src-tauri/target/<profile>/, so a few
        // levels up is the checkout root.
        let mut dir = exe.parent();
        for _ in 0..6 {
            let Some(candidate) = dir else { break };
            if let Some(root) = repo_root_from(candidate) {
                roots.push(root);
            }
            dir = candidate.parent();
        }
    }
    roots.dedup();
    roots
}

/// Resolve the command that starts the Paperclip API + UI.
pub fn resolve_server_launch() -> Result<ServerLaunch, String> {
    if let Some(raw) = env::var_os("PAPERCLIP_DESKTOP_SERVER") {
        let raw = raw.to_string_lossy().to_string();
        let parts = split_argv(&raw);
        let Some((program, rest)) = parts.split_first() else {
            return Err("PAPERCLIP_DESKTOP_SERVER is set but empty".to_string());
        };
        return Ok(ServerLaunch {
            program: OsString::from(program),
            args: rest.iter().map(OsString::from).collect(),
            source: "PAPERCLIP_DESKTOP_SERVER".to_string(),
        });
    }

    if let Some(entry) = env::var_os("PAPERCLIP_DESKTOP_SERVER_ENTRY") {
        return Ok(ServerLaunch {
            program: node_program(),
            args: vec![entry],
            source: "PAPERCLIP_DESKTOP_SERVER_ENTRY".to_string(),
        });
    }

    let mut searched: Vec<String> = Vec::new();
    for root in repo_candidates() {
        let entry = root.join("server").join("dist").join("index.js");
        if entry.is_file() {
            return Ok(ServerLaunch {
                program: node_program(),
                args: vec![entry.into_os_string()],
                source: format!("repo checkout ({})", root.display()),
            });
        }
        searched.push(entry.display().to_string());
    }

    if which("paperclipai").is_some() {
        return Ok(ServerLaunch {
            program: OsString::from("paperclipai"),
            args: Vec::new(),
            source: "paperclipai on PATH".to_string(),
        });
    }

    Err(format!(
        "No Paperclip server found. Build one with `pnpm --filter @paperclipai/server build`, \
         or set PAPERCLIP_DESKTOP_SERVER_ENTRY / PAPERCLIP_DESKTOP_SERVER. Looked in: {}",
        if searched.is_empty() {
            "<no repository checkout nearby>".to_string()
        } else {
            searched.join(", ")
        }
    ))
}

/// Minimal `PATH` lookup. Avoids a dependency for one call.
pub fn which(program: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    let exts: Vec<String> = if cfg!(windows) {
        env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".to_string())
            .split(';')
            .map(|e| e.to_ascii_lowercase())
            .collect()
    } else {
        Vec::new()
    };
    for dir in env::split_paths(&path) {
        let base = dir.join(program);
        if base.is_file() {
            return Some(base);
        }
        for ext in &exts {
            let candidate = dir.join(format!("{program}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// True when something already answers `/api/health` on this port.
///
/// A desktop shell that starts a second server against the same database is a
/// corruption risk, so an already-running instance is adopted instead. The
/// request is written by hand over a loopback socket: the probe runs on the
/// startup path and must not pull an HTTP client into the binary.
pub fn probe_health(port: u16) -> bool {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    let host = local_host().unwrap_or("localhost");
    let Ok(mut stream) = TcpStream::connect((host, port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(750)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(750)));
    let request = format!(
        "GET /api/health HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nUser-Agent: paperclip-desktop\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = Vec::new();
    // Read the status line only; the body can be arbitrarily large.
    let _ = stream.take(256).read_to_end(&mut response);
    let text = String::from_utf8_lossy(&response);
    text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200")
}

/// The host to dial. `localhost` resolves to `::1` first on some machines while
/// the server may be bound to IPv4 only, so prefer the IPv4 loopback literal.
pub fn local_host() -> Option<&'static str> {
    if cfg!(windows) || cfg!(target_os = "linux") || cfg!(target_os = "macos") {
        Some("127.0.0.1")
    } else {
        None
    }
}

/// The base URL the window loads once the server is healthy.
pub fn base_url(port: u16) -> String {
    format!("http://{}:{}", local_host().unwrap_or("localhost"), port)
}

/// Pick the port to serve on: an explicit override, else the default if free,
/// else the next free ports up to `PORT_ATTEMPTS`.
pub fn resolve_port() -> Result<u16, String> {
    if let Some(raw) = env::var_os("PAPERCLIP_DESKTOP_PORT") {
        let parsed: u16 = raw
            .to_string_lossy()
            .trim()
            .parse()
            .map_err(|_| format!("PAPERCLIP_DESKTOP_PORT is not a port number: {raw:?}"))?;
        return Ok(parsed);
    }
    for offset in 0..PORT_ATTEMPTS {
        let candidate = DEFAULT_PORT.saturating_add(offset);
        if candidate == u16::MAX {
            break;
        }
        if !port_in_use(candidate) {
            return Ok(candidate);
        }
    }
    Err(format!(
        "No free port in {DEFAULT_PORT}..{}",
        DEFAULT_PORT.saturating_add(PORT_ATTEMPTS)
    ))
}

fn port_in_use(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_err()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_quoted_argv() {
        let parts = split_argv(r#"node "C:\Program Files\paperclip\dist\index.js" --port 3100"#);
        assert_eq!(
            parts,
            vec![
                "node".to_string(),
                r"C:\Program Files\paperclip\dist\index.js".to_string(),
                "--port".to_string(),
                "3100".to_string(),
            ]
        );
    }

    #[test]
    fn splits_bare_words() {
        assert_eq!(split_argv("  paperclipai   start "), vec!["paperclipai", "start"]);
    }

    #[test]
    fn builds_loopback_base_url() {
        assert_eq!(base_url(3100), "http://127.0.0.1:3100");
    }
}