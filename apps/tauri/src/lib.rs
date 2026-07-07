mod backend;

use backend::{BackendManager, BackendSession};
use std::path::PathBuf;
use tauri::{Manager, State};

#[tauri::command]
fn backend_session(manager: State<'_, BackendManager>) -> Result<BackendSession, String> {
    manager.session()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let manager = match resolve_api_dir(app) {
                Ok(api_dir) => BackendManager::start(api_dir),
                Err(error) => BackendManager::failed(error),
            };
            app.manage(manager);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![backend_session])
        .run(tauri::generate_context!())
        .expect("error while running Optipass");
}

fn resolve_api_dir(app: &tauri::App) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("api"));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("api"),
    );

    candidates
        .into_iter()
        .find(|candidate| candidate.join("dist").join("helper.js").is_file())
        .ok_or_else(|| "Cannot find packaged Optipass API helper. Run `just dev-tauri` or package API resources first.".to_string())
}
