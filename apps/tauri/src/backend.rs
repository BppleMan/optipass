use serde::{Deserialize, Serialize};
use std::env;
use std::fs::{create_dir_all, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const READY_PREFIX: &str = "OPTIPASS_READY ";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendSession {
    pub base_url: String,
    pub token: String,
}

pub struct BackendManager {
    state: Mutex<BackendState>,
}

impl BackendManager {
    pub fn start(backend_dir: PathBuf) -> Self {
        let state = match BackendProcess::spawn(backend_dir) {
            Ok(process) => BackendState::Running(process),
            Err(error) => {
                log_helper_line(
                    &helper_log_sink(),
                    "state",
                    &format!("Failed to start API helper: {error}"),
                );
                BackendState::Failed(error)
            }
        };
        Self {
            state: Mutex::new(state),
        }
    }

    pub fn failed(error: String) -> Self {
        log_helper_line(
            &helper_log_sink(),
            "state",
            &format!("API helper unavailable: {error}"),
        );
        Self {
            state: Mutex::new(BackendState::Failed(error)),
        }
    }

    pub fn session(&self) -> Result<BackendSession, String> {
        match self.state.lock() {
            Ok(state) => match &*state {
                BackendState::Running(process) => Ok(process.session.clone()),
                BackendState::Failed(error) => Err(error.clone()),
                BackendState::Stopped => {
                    Err("Optipass API helper has already stopped.".to_string())
                }
            },
            Err(_) => Err("Optipass backend state is unavailable.".to_string()),
        }
    }
}

impl Drop for BackendManager {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            if let BackendState::Running(process) =
                std::mem::replace(&mut *state, BackendState::Stopped)
            {
                let mut process = process;
                process.shutdown();
            }
        }
    }
}

enum BackendState {
    Running(BackendProcess),
    Failed(String),
    Stopped,
}

struct BackendProcess {
    child: Child,
    session: BackendSession,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HelperRuntimeKind {
    Bun,
    Node,
}

impl HelperRuntimeKind {
    fn as_label(self) -> &'static str {
        match self {
            Self::Bun => "bun",
            Self::Node => "node",
        }
    }
}

#[derive(Clone, Debug)]
struct HelperRuntime {
    kind: HelperRuntimeKind,
    binary: PathBuf,
}

impl BackendProcess {
    fn spawn(backend_dir: PathBuf) -> Result<Self, String> {
        let runtime = find_helper_runtime(&backend_dir)?;
        let runtime_kind = runtime.kind;
        let runtime_binary = runtime.binary.clone();
        let entrypoint = backend_dir.join("dist").join("helper.js");
        if !entrypoint.is_file() {
            return Err(format!(
                "Cannot find API helper entrypoint at {}.",
                entrypoint.display()
            ));
        }

        let token = generate_session_token();
        let mut command = build_helper_command(&runtime, &entrypoint, &backend_dir, &token);

        let mut child = command.spawn().map_err(|error| {
            format!(
                "Failed to start API helper runtime {} with {}: {error}",
                runtime_kind.as_label(),
                runtime_binary.display()
            )
        })?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "API helper stdout was not available.".to_string())?;
        let stderr = child.stderr.take();
        let (ready_tx, ready_rx) = mpsc::channel();
        let log_sink = helper_log_sink();
        let stdout_log_sink = log_sink.clone();
        log_helper_line(
            &log_sink,
            "state",
            &format!(
                "Starting API helper runtime {} at {}",
                runtime_kind.as_label(),
                runtime_binary.display()
            ),
        );

        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        if let Some(payload) = parse_ready_line(&line) {
                            let _ = ready_tx.send(Ok(payload));
                        } else {
                            log_helper_line(&stdout_log_sink, "stdout", &line);
                        }
                    }
                    Err(error) => {
                        let _ = ready_tx
                            .send(Err(format!("Failed to read API helper stdout: {error}")));
                        break;
                    }
                }
            }
        });

        if let Some(stderr) = stderr {
            let stderr_log_sink = log_sink.clone();
            thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    log_helper_line(&stderr_log_sink, "stderr", &line);
                }
            });
        }

        let ready = match ready_rx.recv_timeout(STARTUP_TIMEOUT) {
            Ok(Ok(payload)) => payload,
            Ok(Err(error)) => {
                let _ = child.kill();
                return Err(error);
            }
            Err(_) => {
                let _ = child.kill();
                return Err("Timed out waiting for Optipass API helper to start.".to_string());
            }
        };

        if ready.mode != "tauri" {
            let _ = child.kill();
            return Err(format!(
                "API helper started in unsupported mode `{}`.",
                ready.mode
            ));
        }
        if ready.pid == 0 {
            let _ = child.kill();
            return Err("API helper returned an invalid pid.".to_string());
        }
        if ready.host != "127.0.0.1"
            || ready.port == 0
            || !ready.api_base_url.ends_with(&ready.port.to_string())
        {
            let _ = child.kill();
            return Err("API helper returned an invalid listener address.".to_string());
        }
        if ready.token != token {
            let _ = child.kill();
            return Err("API helper returned an unexpected session token.".to_string());
        }
        if ready.started_at.is_empty() {
            let _ = child.kill();
            return Err("API helper returned an invalid startup timestamp.".to_string());
        }

        log_helper_line(
            &log_sink,
            "state",
            &format!(
                "API helper listening at {} via {}",
                ready.api_base_url,
                runtime_kind.as_label()
            ),
        );

        Ok(Self {
            child,
            session: BackendSession {
                base_url: ready.api_base_url,
                token: ready.token,
            },
        })
    }

    fn shutdown(&mut self) {
        let _ = send_shutdown_request(&self.session);
        let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadyPayload {
    pid: u32,
    host: String,
    port: u16,
    token: String,
    mode: String,
    api_base_url: String,
    started_at: String,
}

fn parse_ready_line(line: &str) -> Option<ReadyPayload> {
    let payload = line.strip_prefix(READY_PREFIX)?;
    serde_json::from_str(payload).ok()
}

fn generate_session_token() -> String {
    Uuid::new_v4().to_string()
}

fn build_helper_command(
    runtime: &HelperRuntime,
    entrypoint: &Path,
    backend_dir: &Path,
    token: &str,
) -> Command {
    let mut command = Command::new(&runtime.binary);
    command
        .arg(entrypoint)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg("0")
        .arg("--token")
        .arg(token)
        .current_dir(backend_dir)
        .env("APP_MODE", "tauri")
        .env("APP_SESSION_TOKEN", token)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn find_helper_runtime(api_dir: &Path) -> Result<HelperRuntime, String> {
    let bun = embedded_bun_path(api_dir);
    if is_usable_bun(&bun) {
        return Ok(HelperRuntime {
            kind: HelperRuntimeKind::Bun,
            binary: bun,
        });
    }

    find_node_binary()
        .map(|binary| HelperRuntime {
            kind: HelperRuntimeKind::Node,
            binary,
        })
        .map_err(|node_error| {
            format!(
                "Cannot find bundled Bun runtime at {} and {node_error}",
                bun.display()
            )
        })
}

fn embedded_bun_path(api_dir: &Path) -> PathBuf {
    api_dir
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("runtime")
        .join("bun")
        .join(if cfg!(windows) { "bun.exe" } else { "bun" })
}

fn helper_log_sink() -> Option<Arc<Mutex<File>>> {
    let dir = helper_log_dir();
    create_dir_all(&dir).ok()?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("api.log"))
        .ok()
        .map(|file| Arc::new(Mutex::new(file)))
}

fn helper_log_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        if let Some(home) = env::var_os("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Logs")
                .join("Optipass");
        }
    }
    env::temp_dir().join("Optipass").join("Logs")
}

fn log_helper_line(log_sink: &Option<Arc<Mutex<File>>>, stream: &str, line: &str) {
    eprintln!("[optipass-api] [{stream}] {line}");
    if let Some(log_sink) = log_sink {
        if let Ok(mut file) = log_sink.lock() {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_secs())
                .unwrap_or_default();
            let _ = writeln!(file, "{timestamp}\t{stream}\t{line}");
        }
    }
}

fn find_node_binary() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(path) = env::var_os("OPTIPASS_NODE") {
        candidates.push(PathBuf::from(path));
    }
    candidates.extend(node_paths_from_path());
    candidates.extend(node_paths_from_version_managers());
    candidates.push(PathBuf::from("/opt/homebrew/bin/node"));
    candidates.push(PathBuf::from("/usr/local/bin/node"));
    candidates.push(PathBuf::from("/usr/bin/node"));

    for candidate in candidates {
        if is_usable_node(&candidate) {
            return Ok(candidate);
        }
    }

    Err("Cannot find Node.js >= 20. Set OPTIPASS_NODE to a usable node executable.".to_string())
}

fn node_paths_from_path() -> Vec<PathBuf> {
    env::var_os("PATH")
        .map(|path| {
            env::split_paths(&path)
                .map(|dir| dir.join(if cfg!(windows) { "node.exe" } else { "node" }))
                .collect()
        })
        .unwrap_or_default()
}

fn node_paths_from_version_managers() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let Some(home) = env::var_os("HOME").map(PathBuf::from) else {
        return candidates;
    };

    candidates.push(home.join(".volta").join("bin").join("node"));
    candidates.push(home.join(".asdf").join("shims").join("node"));
    candidates.extend(versioned_node_paths(
        &home
            .join(".local")
            .join("share")
            .join("fnm")
            .join("node-versions"),
        &["installation", "bin", "node"],
    ));
    candidates.extend(versioned_node_paths(
        &home.join(".nvm").join("versions").join("node"),
        &["bin", "node"],
    ));
    candidates
}

fn versioned_node_paths(root: &Path, suffix: &[&str]) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let Ok(entries) = root.read_dir() else {
        return paths;
    };
    for entry in entries.flatten() {
        let mut path = entry.path();
        for part in suffix {
            path = path.join(part);
        }
        paths.push(path);
    }
    paths.sort_by(|left, right| right.cmp(left));
    paths
}

fn is_usable_node(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    Command::new(path)
        .arg("--version")
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|version| parse_node_major_version(&version))
        .is_some_and(|major| major >= 20)
}

fn is_usable_bun(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    Command::new(path)
        .arg("--version")
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|version| parse_bun_major_version(&version))
        .is_some_and(|major| major >= 1)
}

fn parse_node_major_version(version: &str) -> Option<u32> {
    version
        .trim()
        .strip_prefix('v')?
        .split('.')
        .next()?
        .parse()
        .ok()
}

fn parse_bun_major_version(version: &str) -> Option<u32> {
    version.trim().split('.').next()?.parse().ok()
}

fn send_shutdown_request(session: &BackendSession) -> std::io::Result<()> {
    let authority = http_authority(&session.base_url).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid backend URL")
    })?;
    let mut stream = TcpStream::connect(authority)?;
    stream.set_write_timeout(Some(Duration::from_secs(1)))?;
    stream.set_read_timeout(Some(Duration::from_secs(1)))?;
    let request = format!(
        "POST /api/session/shutdown HTTP/1.1\r\nHost: {authority}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nx-session-token: {}\r\nConnection: close\r\n\r\n{{}}",
        session.token
    );
    stream.write_all(request.as_bytes())
}

fn http_authority(base_url: &str) -> Option<&str> {
    base_url.trim_end_matches('/').strip_prefix("http://")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn explicit_env(command: &Command, name: &str) -> Option<String> {
        command
            .get_envs()
            .find(|(key, _)| key.to_string_lossy() == name)
            .and_then(|(_, value)| value.map(|value| value.to_string_lossy().into_owned()))
    }

    #[test]
    fn parses_node_major_versions() {
        assert_eq!(parse_node_major_version("v20.11.1"), Some(20));
        assert_eq!(parse_node_major_version("v19.9.0"), Some(19));
        assert_eq!(parse_node_major_version("20.11.1"), None);
    }

    #[test]
    fn parses_bun_major_versions() {
        assert_eq!(parse_bun_major_version("1.3.14"), Some(1));
        assert_eq!(parse_bun_major_version("0.8.1"), Some(0));
        assert_eq!(parse_bun_major_version("bun 1.3.14"), None);
    }

    #[test]
    fn parses_ready_lines() {
        let line = r#"OPTIPASS_READY {"pid":1,"host":"127.0.0.1","port":49152,"token":"token","mode":"tauri","apiBaseUrl":"http://127.0.0.1:49152","startedAt":"2026-01-01T00:00:00.000Z"}"#;
        let payload = parse_ready_line(line).expect("ready payload");

        assert_eq!(payload.pid, 1);
        assert_eq!(payload.host, "127.0.0.1");
        assert_eq!(payload.port, 49152);
        assert_eq!(payload.api_base_url, "http://127.0.0.1:49152");
    }

    #[test]
    fn extracts_http_authority() {
        assert_eq!(
            http_authority("http://127.0.0.1:49152"),
            Some("127.0.0.1:49152")
        );
        assert_eq!(
            http_authority("http://127.0.0.1:49152/"),
            Some("127.0.0.1:49152")
        );
        assert_eq!(http_authority("https://127.0.0.1:49152"), None);
    }

    #[test]
    fn helper_command_does_not_force_dry_run_by_default() {
        let runtime = HelperRuntime {
            kind: HelperRuntimeKind::Bun,
            binary: PathBuf::from("/usr/bin/bun"),
        };
        let command = build_helper_command(
            &runtime,
            Path::new("/tmp/optipass/api/dist/helper.js"),
            Path::new("/tmp/optipass/api"),
            "session-token",
        );

        assert_eq!(command.get_program(), Path::new("/usr/bin/bun").as_os_str());
        assert_eq!(
            explicit_env(&command, "APP_MODE"),
            Some("tauri".to_string())
        );
        assert_eq!(
            explicit_env(&command, "APP_SESSION_TOKEN"),
            Some("session-token".to_string())
        );
        assert_eq!(explicit_env(&command, "OP_FORCE_DRY_RUN"), None);
    }

    #[test]
    fn resolves_embedded_bun_next_to_api_resource() {
        assert_eq!(
            embedded_bun_path(Path::new(
                "/Applications/Optipass.app/Contents/Resources/api"
            )),
            PathBuf::from("/Applications/Optipass.app/Contents/Resources/runtime/bun/bun")
        );
    }
}
