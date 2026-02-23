use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Command;
use tauri::{Emitter, Manager};

const RELAY_API: &str = "https://claude.iptinno.com";
const NODE_VERSION: &str = "v22.14.0";

// ── Config paths (must match lib/config.js) ──

fn get_config_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join("remote-clauding");
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = dirs::home_dir() {
            return home.join("Library/Application Support/remote-clauding");
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
            return PathBuf::from(xdg).join("remote-clauding");
        }
        if let Some(home) = dirs::home_dir() {
            return home.join(".config/remote-clauding");
        }
    }
    PathBuf::from("remote-clauding")
}

fn ensure_config_dir() {
    let dir = get_config_dir();
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
}

// ── Serializable types ──

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct AppConfig {
    pub auth_token: Option<String>,
    pub email: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct NodeConfig {
    pub portable: bool,
    #[serde(default)]
    pub node_path: String,
}

#[derive(Serialize)]
pub struct NodeCheckResult {
    pub found: bool,
    pub version: String,
    pub path: String,
    pub portable: bool,
}

#[derive(Serialize)]
pub struct HealthResult {
    pub running: bool,
}

// ── Helper: find node and npm paths ──

fn get_portable_node_dir() -> PathBuf {
    get_config_dir().join("node")
}

fn get_node_binary(portable: bool) -> String {
    if portable {
        let dir = get_portable_node_dir();
        #[cfg(target_os = "windows")]
        {
            dir.join("node.exe").to_string_lossy().to_string()
        }
        #[cfg(not(target_os = "windows"))]
        {
            dir.join("bin").join("node").to_string_lossy().to_string()
        }
    } else {
        "node".to_string()
    }
}

fn get_npm_binary(portable: bool) -> (String, Vec<String>) {
    if portable {
        let dir = get_portable_node_dir();
        #[cfg(target_os = "windows")]
        {
            let npm_cmd = dir.join("npm.cmd");
            (npm_cmd.to_string_lossy().to_string(), vec![])
        }
        #[cfg(not(target_os = "windows"))]
        {
            let npm = dir.join("bin").join("npm");
            (npm.to_string_lossy().to_string(), vec![])
        }
    } else {
        #[cfg(target_os = "windows")]
        {
            ("cmd.exe".to_string(), vec!["/C".to_string(), "npm".to_string()])
        }
        #[cfg(not(target_os = "windows"))]
        {
            ("npm".to_string(), vec![])
        }
    }
}

fn get_cli_binary(portable: bool) -> (String, Vec<String>) {
    if portable {
        let dir = get_portable_node_dir();
        #[cfg(target_os = "windows")]
        {
            // When installed with portable npm, the global bin is inside the node dir
            let prefix_dir = dir.to_string_lossy().to_string();
            let cli = format!("{}\\remote-clauding.cmd", prefix_dir);
            if PathBuf::from(&cli).exists() {
                return (cli, vec![]);
            }
            // Fallback: use npx
            let npx = dir.join("npx.cmd");
            (npx.to_string_lossy().to_string(), vec!["remote-clauding".to_string()])
        }
        #[cfg(not(target_os = "windows"))]
        {
            let cli = dir.join("bin").join("remote-clauding");
            (cli.to_string_lossy().to_string(), vec![])
        }
    } else {
        #[cfg(target_os = "windows")]
        {
            ("cmd.exe".to_string(), vec!["/C".to_string(), "remote-clauding".to_string()])
        }
        #[cfg(not(target_os = "windows"))]
        {
            ("remote-clauding".to_string(), vec![])
        }
    }
}

fn read_node_config() -> NodeConfig {
    let path = get_config_dir().join("node-config.json");
    if let Ok(data) = fs::read_to_string(&path) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        NodeConfig::default()
    }
}

fn save_node_config(config: &NodeConfig) {
    ensure_config_dir();
    let path = get_config_dir().join("node-config.json");
    if let Ok(json) = serde_json::to_string_pretty(config) {
        let _ = fs::write(path, json);
    }
}

// ── Tauri Commands ──

#[tauri::command]
fn check_install_state() -> String {
    let config_dir = get_config_dir();
    let marker = config_dir.join("installed.marker");

    if marker.exists() {
        return "app".to_string();
    }

    // Check if remote-clauding is already on PATH
    if Command::new("remote-clauding")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        let _ = fs::create_dir_all(&config_dir);
        let _ = fs::write(&marker, "installed");
        return "app".to_string();
    }

    // Also check portable node's global bin
    let node_config = read_node_config();
    if node_config.portable {
        let (cli, _) = get_cli_binary(true);
        if PathBuf::from(&cli).exists() {
            let _ = fs::create_dir_all(&config_dir);
            let _ = fs::write(&marker, "installed");
            return "app".to_string();
        }
    }

    "installer".to_string()
}

#[tauri::command]
fn check_node() -> NodeCheckResult {
    // Try system node first
    if let Ok(output) = Command::new("node").arg("--version").output() {
        if output.status.success() {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return NodeCheckResult {
                found: true,
                version,
                path: "node".to_string(),
                portable: false,
            };
        }
    }

    // Try portable node
    let node = get_node_binary(true);
    if PathBuf::from(&node).exists() {
        if let Ok(output) = Command::new(&node).arg("--version").output() {
            if output.status.success() {
                let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                return NodeCheckResult {
                    found: true,
                    version,
                    path: node,
                    portable: true,
                };
            }
        }
    }

    NodeCheckResult {
        found: false,
        version: String::new(),
        path: String::new(),
        portable: false,
    }
}

#[tauri::command]
fn download_portable_node(window: tauri::Window) -> Result<String, String> {
    let _ = window.emit("install_progress", serde_json::json!({
        "step": "download_node",
        "status": "started",
        "message": "Downloading Node.js..."
    }));

    let (url, archive_name) = get_node_download_url();
    let config_dir = get_config_dir();
    ensure_config_dir();
    let archive_path = config_dir.join(&archive_name);
    let node_dir = get_portable_node_dir();

    // Download
    let client = reqwest::blocking::Client::new();
    let mut response = client.get(&url).send().map_err(|e| format!("Download failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Download failed with status: {}", response.status()));
    }

    let total_size = response.content_length().unwrap_or(0);
    let mut file = fs::File::create(&archive_path).map_err(|e| format!("Cannot create file: {}", e))?;
    let mut downloaded: u64 = 0;
    let mut buffer = [0u8; 65536];

    loop {
        let bytes_read = response.read(&mut buffer).map_err(|e| format!("Read error: {}", e))?;
        if bytes_read == 0 {
            break;
        }
        file.write_all(&buffer[..bytes_read]).map_err(|e| format!("Write error: {}", e))?;
        downloaded += bytes_read as u64;
        if total_size > 0 {
            let percent = (downloaded as f64 / total_size as f64 * 100.0) as u32;
            let _ = window.emit("install_progress", serde_json::json!({
                "step": "download_node",
                "status": "progress",
                "percent": percent,
                "message": format!("Downloading Node.js... {}%", percent)
            }));
        }
    }
    drop(file);

    let _ = window.emit("install_progress", serde_json::json!({
        "step": "download_node",
        "status": "extracting",
        "message": "Extracting Node.js..."
    }));

    // Extract
    if node_dir.exists() {
        let _ = fs::remove_dir_all(&node_dir);
    }
    fs::create_dir_all(&node_dir).map_err(|e| format!("Cannot create node dir: {}", e))?;

    #[cfg(target_os = "windows")]
    {
        extract_zip(&archive_path, &node_dir)?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        extract_tar_gz(&archive_path, &node_dir)?;
    }

    // Clean up archive
    let _ = fs::remove_file(&archive_path);

    // Save node config
    save_node_config(&NodeConfig {
        portable: true,
        node_path: node_dir.to_string_lossy().to_string(),
    });

    let _ = window.emit("install_progress", serde_json::json!({
        "step": "download_node",
        "status": "done",
        "message": "Node.js installed."
    }));

    Ok(get_node_binary(true))
}

fn get_node_download_url() -> (String, String) {
    let (os, ext) = if cfg!(target_os = "windows") {
        ("win", "zip")
    } else if cfg!(target_os = "macos") {
        ("darwin", "tar.gz")
    } else {
        ("linux", "tar.gz")
    };

    let arch = if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };

    let name = format!("node-{}-{}-{}", NODE_VERSION, os, arch);
    let filename = format!("{}.{}", name, ext);
    let url = format!("https://nodejs.org/dist/{}/{}", NODE_VERSION, filename);
    (url, filename)
}

#[cfg(target_os = "windows")]
fn extract_zip(archive: &PathBuf, dest: &PathBuf) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|e| format!("Cannot open zip: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Invalid zip: {}", e))?;

    // Find the top-level directory name (e.g., node-v22.14.0-win-x64/)
    let top_dir = archive
        .by_index(0)
        .map_err(|e| format!("Zip error: {}", e))?
        .name()
        .split('/')
        .next()
        .unwrap_or("")
        .to_string();

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("Zip entry error: {}", e))?;
        let name = entry.name().to_string();

        // Strip the top-level directory
        let relative = if !top_dir.is_empty() && name.starts_with(&top_dir) {
            name[top_dir.len()..].trim_start_matches('/')
        } else {
            &name
        };

        if relative.is_empty() {
            continue;
        }

        let out_path = dest.join(relative);

        if entry.is_dir() {
            let _ = fs::create_dir_all(&out_path);
        } else {
            if let Some(parent) = out_path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let mut out_file = fs::File::create(&out_path)
                .map_err(|e| format!("Cannot create {}: {}", out_path.display(), e))?;
            std::io::copy(&mut entry, &mut out_file)
                .map_err(|e| format!("Extract error: {}", e))?;
        }
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn extract_tar_gz(archive: &PathBuf, dest: &PathBuf) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|e| format!("Cannot open archive: {}", e))?;
    let gz = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(gz);

    for entry in tar.entries().map_err(|e| format!("Tar error: {}", e))? {
        let mut entry = entry.map_err(|e| format!("Tar entry error: {}", e))?;
        let path = entry.path().map_err(|e| format!("Path error: {}", e))?.to_path_buf();

        // Strip the top-level directory
        let components: Vec<_> = path.components().collect();
        if components.len() <= 1 {
            continue;
        }
        let relative: PathBuf = components[1..].iter().collect();
        let out_path = dest.join(&relative);

        if entry.header().entry_type().is_dir() {
            let _ = fs::create_dir_all(&out_path);
        } else {
            if let Some(parent) = out_path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            entry.unpack(&out_path).map_err(|e| format!("Unpack error: {}", e))?;
        }
    }

    Ok(())
}

#[tauri::command]
fn install_npm_package(app_handle: tauri::AppHandle, window: tauri::Window) -> Result<String, String> {
    let _ = window.emit("install_progress", serde_json::json!({
        "step": "install_npm",
        "status": "started",
        "message": "Installing Remote Clauding..."
    }));

    let node_config = read_node_config();
    let (npm, extra_args) = get_npm_binary(node_config.portable);

    // Get the bundled npm package path from Tauri resources
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| format!("Cannot find resources: {}", e))?;

    // The npm-package files are bundled at the resource root
    let package_dir = resource_dir.join("npm-package");

    // Fallback: if running in dev mode, use the monorepo root
    let install_path = if package_dir.exists() {
        package_dir
    } else {
        // Dev fallback: go up from tauri-app/src-tauri to repo root
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.to_path_buf())
            .unwrap_or(package_dir)
    };

    let mut cmd = Command::new(&npm);
    for arg in &extra_args {
        cmd.arg(arg);
    }
    cmd.arg("install")
        .arg("-g")
        .arg(install_path.to_string_lossy().to_string());

    // If portable, set the prefix to the portable node dir
    if node_config.portable {
        let prefix = get_portable_node_dir();
        cmd.arg(format!("--prefix={}", prefix.to_string_lossy()));
    }

    let output = cmd.output().map_err(|e| format!("npm install failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        let _ = window.emit("install_progress", serde_json::json!({
            "step": "install_npm",
            "status": "error",
            "message": format!("npm install failed: {}", stderr)
        }));
        return Err(format!("npm install failed: {}\n{}", stderr, stdout));
    }

    let _ = window.emit("install_progress", serde_json::json!({
        "step": "install_npm",
        "status": "done",
        "message": "Remote Clauding installed."
    }));

    Ok(stdout)
}

#[tauri::command]
fn run_setup(window: tauri::Window) -> Result<String, String> {
    let _ = window.emit("install_progress", serde_json::json!({
        "step": "setup",
        "status": "started",
        "message": "Installing VSCode extension..."
    }));

    let node_config = read_node_config();
    let (cli, args) = get_cli_binary(node_config.portable);

    let mut cmd = Command::new(&cli);
    for arg in &args {
        cmd.arg(arg);
    }
    cmd.arg("setup");

    let output = cmd.output().map_err(|e| format!("Setup failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    let _ = window.emit("install_progress", serde_json::json!({
        "step": "setup",
        "status": if output.status.success() { "done" } else { "error" },
        "message": if output.status.success() {
            "VSCode extension installed.".to_string()
        } else {
            format!("VSCode extension install failed: {}", stderr)
        }
    }));

    if output.status.success() {
        Ok(stdout)
    } else {
        Err(format!("{}\n{}", stderr, stdout))
    }
}

#[tauri::command]
fn mark_installed() -> Result<(), String> {
    ensure_config_dir();
    let marker = get_config_dir().join("installed.marker");
    fs::write(&marker, "installed").map_err(|e| format!("Cannot write marker: {}", e))
}

#[tauri::command]
fn read_config() -> AppConfig {
    let path = get_config_dir().join("config.json");
    if let Ok(data) = fs::read_to_string(&path) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        AppConfig::default()
    }
}

fn save_config(config: &AppConfig) {
    ensure_config_dir();
    let path = get_config_dir().join("config.json");
    if let Ok(json) = serde_json::to_string_pretty(config) {
        let _ = fs::write(path, json);
    }
}

#[tauri::command]
fn register(email: String, password: String) -> Result<serde_json::Value, String> {
    let client = reqwest::blocking::Client::new();
    let res = client
        .post(format!("{}/api/auth/register", RELAY_API))
        .json(&serde_json::json!({ "email": email, "password": password }))
        .send()
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = res.status();
    let body: serde_json::Value = res.json().map_err(|e| format!("Parse error: {}", e))?;

    if !status.is_success() {
        let error = body["error"].as_str().unwrap_or("Registration failed");
        return Err(error.to_string());
    }

    // If we got a token directly, save config
    if let Some(token) = body["auth_token"].as_str() {
        save_config(&AppConfig {
            auth_token: Some(token.to_string()),
            email: Some(email),
        });
    }

    Ok(body)
}

#[tauri::command]
fn verify_email(email: String, code: String) -> Result<serde_json::Value, String> {
    let client = reqwest::blocking::Client::new();
    let res = client
        .post(format!("{}/api/auth/verify-email", RELAY_API))
        .json(&serde_json::json!({ "email": email, "code": code }))
        .send()
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = res.status();
    let body: serde_json::Value = res.json().map_err(|e| format!("Parse error: {}", e))?;

    if !status.is_success() {
        let error = body["error"].as_str().unwrap_or("Verification failed");
        return Err(error.to_string());
    }

    // If we got a token, save config
    if let Some(token) = body["auth_token"].as_str() {
        save_config(&AppConfig {
            auth_token: Some(token.to_string()),
            email: Some(email),
        });
    }

    Ok(body)
}

#[tauri::command]
fn login(email: String, password: String) -> Result<serde_json::Value, String> {
    let client = reqwest::blocking::Client::new();
    let res = client
        .post(format!("{}/api/auth/login", RELAY_API))
        .json(&serde_json::json!({ "email": email, "password": password }))
        .send()
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = res.status();
    let body: serde_json::Value = res.json().map_err(|e| format!("Parse error: {}", e))?;

    if !status.is_success() {
        let error = body["error"].as_str().unwrap_or("Login failed");
        return Err(error.to_string());
    }

    if let Some(token) = body["auth_token"].as_str() {
        save_config(&AppConfig {
            auth_token: Some(token.to_string()),
            email: Some(email),
        });
    }

    Ok(body)
}

#[tauri::command]
fn logout() -> Result<(), String> {
    stop_agent_internal();
    let config_path = get_config_dir().join("config.json");
    let _ = fs::remove_file(config_path);
    Ok(())
}

#[tauri::command]
fn start_agent() -> Result<(), String> {
    let node_config = read_node_config();
    let (cli, args) = get_cli_binary(node_config.portable);

    let mut cmd = Command::new(&cli);
    for arg in &args {
        cmd.arg(arg);
    }
    cmd.arg("start");

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    let child = cmd.spawn().map_err(|e| format!("Failed to start agent: {}", e))?;

    // Write PID
    ensure_config_dir();
    let pid_path = get_config_dir().join("agent.pid");
    let _ = fs::write(pid_path, child.id().to_string());

    Ok(())
}

fn stop_agent_internal() {
    let pid_path = get_config_dir().join("agent.pid");
    if let Ok(pid_str) = fs::read_to_string(&pid_path) {
        if let Ok(pid) = pid_str.trim().parse::<u32>() {
            #[cfg(target_os = "windows")]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/F"])
                    .output();
            }
            #[cfg(not(target_os = "windows"))]
            {
                unsafe {
                    libc::kill(pid as i32, libc::SIGTERM);
                }
            }
        }
    }
    let _ = fs::remove_file(pid_path);
}

#[tauri::command]
fn stop_agent() -> Result<(), String> {
    stop_agent_internal();
    Ok(())
}

#[derive(Serialize)]
pub struct AccountStatus {
    pub status: String,
    pub email: String,
    pub email_verified: bool,
}

#[tauri::command]
fn check_account_status() -> Result<AccountStatus, String> {
    let config = read_config();
    let token = config.auth_token.unwrap_or_default();
    if token.is_empty() {
        return Err("Not logged in".to_string());
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new());

    let res = client
        .get(format!("{}/api/auth/me", RELAY_API))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| format!("Request failed: {}", e))?;

    let status_code = res.status();
    let body: serde_json::Value = res.json().map_err(|e| format!("Parse error: {}", e))?;

    if !status_code.is_success() {
        let error = body["error"].as_str().unwrap_or("Unknown error");
        return Err(error.to_string());
    }

    Ok(AccountStatus {
        status: body["status"].as_str().unwrap_or("unknown").to_string(),
        email: body["email"].as_str().unwrap_or("").to_string(),
        email_verified: body["email_verified"].as_bool().unwrap_or(false),
    })
}

#[tauri::command]
fn check_agent_health() -> HealthResult {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new());

    let running = client
        .get("http://127.0.0.1:9680/health")
        .send()
        .map(|r| r.status().is_success())
        .unwrap_or(false);

    HealthResult { running }
}

#[tauri::command]
fn check_relay_health() -> HealthResult {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new());

    let running = client
        .get(format!("{}/health", RELAY_API))
        .send()
        .map(|r| r.status().is_success())
        .unwrap_or(false);

    HealthResult { running }
}

// ── App entry ──

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            check_install_state,
            check_node,
            download_portable_node,
            install_npm_package,
            run_setup,
            mark_installed,
            read_config,
            register,
            verify_email,
            login,
            logout,
            start_agent,
            stop_agent,
            check_account_status,
            check_agent_health,
            check_relay_health,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
