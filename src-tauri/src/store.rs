use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{
    app_state::DEFAULT_REFRESH_INTERVAL_MINUTES,
    usage::CodexUsage,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreShape {
    pub refresh_interval_minutes: u64,
    pub launch_at_login: bool,
    pub last_known_usage: Option<CodexUsage>,
    pub last_updated_at: Option<String>,
}

impl Default for StoreShape {
    fn default() -> Self {
        Self {
            refresh_interval_minutes: DEFAULT_REFRESH_INTERVAL_MINUTES,
            launch_at_login: false,
            last_known_usage: None,
            last_updated_at: None,
        }
    }
}

pub fn load(app: &AppHandle) -> StoreShape {
    let path = store_path(app);
    let Ok(text) = fs::read_to_string(path) else {
        return StoreShape::default();
    };

    serde_json::from_str(&text).unwrap_or_default()
}

pub fn save(app: &AppHandle, store: &StoreShape) -> Result<(), String> {
    let path = store_path(app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let text = serde_json::to_string_pretty(store).map_err(|error| error.to_string())?;
    fs::write(path, text).map_err(|error| error.to_string())
}

pub fn reset(app: &AppHandle) -> Result<(), String> {
    let path = store_path(app);
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn chatgpt_data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| Path::new(".").to_path_buf())
        .join("chatgpt-webview")
}

fn store_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| Path::new(".").to_path_buf())
        .join("codex-quota-tauri.json")
}
