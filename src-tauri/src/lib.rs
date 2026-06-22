use std::sync::{Arc, Mutex};

use chrono::Local;
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

mod app_state;
mod chatgpt;
mod debug;
mod store;
mod summary;
mod time;
mod tray;
mod usage;
mod windows;

#[cfg(test)]
mod tests;

pub type AppData = Arc<Mutex<app_state::RuntimeState>>;

#[tauri::command]
fn get_debug_state(app: tauri::AppHandle) -> debug::DebugState {
    debug::build_debug_state(&state_snapshot(&app), Local::now())
}

#[tauri::command]
async fn refresh_now(app: tauri::AppHandle) -> debug::DebugState {
    refresh_usage(app.clone(), "manual").await;
    debug::build_debug_state(&state_snapshot(&app), Local::now())
}

#[tauri::command]
fn copy_json(app: tauri::AppHandle) -> Result<(), String> {
    let text = debug::to_debug_json(&state_snapshot(&app), Local::now());
    app.clipboard()
        .write_text(text)
        .map_err(|error| error.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = windows::open_debug_window(app);
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            get_debug_state,
            refresh_now,
            copy_json
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_dock_visibility(false);

            let handle = app.handle().clone();
            let stored = store::load(&handle);
            let runtime_state = app_state::RuntimeState::new(
                stored.last_known_usage,
                stored.last_updated_at,
                stored.refresh_interval_minutes,
                stored.launch_at_login,
            );
            app.manage::<AppData>(Arc::new(Mutex::new(runtime_state)));

            if stored.launch_at_login {
                let _ = handle.autolaunch().enable();
            }

            tray::create_tray(&handle)?;
            setup_refresh_timer(handle.clone());
            tauri::async_runtime::spawn(async move {
                refresh_usage(handle, "startup").await;
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let data = app.state::<AppData>();
                let is_quitting = data.lock().map(|state| state.is_quitting).unwrap_or(false);
                if !is_quitting {
                    api.prevent_exit();
                }
            }
        });
}

pub(crate) async fn refresh_usage(app: tauri::AppHandle, source: &'static str) {
    let should_continue = {
        let data = app.state::<AppData>();
        let mut state = match data.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        if state.is_refreshing {
            state.pending_refresh = true;
            false
        } else {
            state.pending_refresh = false;
            state.is_refreshing = true;
            true
        }
    };

    if !should_continue {
        emit_state_changed(&app);
        return;
    }
    emit_state_changed(&app);

    let result = chatgpt::fetch_usage_in_session(&app).await;
    match result {
        Ok(fetch_result) if fetch_result.ok => {
            let Some(data) = fetch_result.data else {
                set_error_state(
                    &app,
                    usage::AppStatus::ParseError,
                    format!("{source} refresh failed: missing usage data"),
                    None,
                );
                run_pending_refresh(&app);
                return;
            };

            match usage::parse_usage_response(data) {
                Ok(usage) => {
                    let last_updated_at = time::now_iso();
                    {
                        let data = app.state::<AppData>();
                        let mut state = match data.lock() {
                            Ok(state) => state,
                            Err(_) => return,
                        };
                        state.usage_comparison = state
                            .usage
                            .as_ref()
                            .map(|previous| usage::compare_usage(previous, &usage));
                        state.status = usage::classify_usage(&usage);
                        state.usage = Some(usage.clone());
                        state.last_updated_at = Some(last_updated_at.clone());
                        state.last_error = None;
                        state.stale = false;
                        state.is_refreshing = false;

                        let store = store::StoreShape {
                            refresh_interval_minutes: state.refresh_interval_minutes,
                            launch_at_login: state.launch_at_login,
                            last_known_usage: Some(usage),
                            last_updated_at: Some(last_updated_at),
                        };
                        let _ = store::save(&app, &store);
                    }
                    windows::close_auto_auth_window_after_refresh(&app);
                    emit_state_changed(&app);
                }
                Err(error) => set_error_state(
                    &app,
                    usage::AppStatus::ParseError,
                    format!("{source} refresh failed: {error}"),
                    None,
                ),
            }
        }
        Ok(fetch_result) => {
            let authenticated_session = fetch_result.authenticated_session.unwrap_or(false);
            let status = if fetch_result.parse_error.unwrap_or(false) {
                usage::AppStatus::ParseError
            } else if fetch_result.text.as_deref() == Some("request_timeout") {
                usage::AppStatus::RequestTimeout
            } else {
                usage::map_http_status_to_app_status(fetch_result.status, authenticated_session)
            };
            let message_prefix = if status == usage::AppStatus::AuthRequired && authenticated_session {
                "Authenticated ChatGPT session, but usage endpoint returned unauthorized. "
            } else {
                ""
            };
            let text = fetch_result.text.unwrap_or_else(|| format!("HTTP {}", fetch_result.status));
            let message = fetch_result
                .final_url
                .map(|url| format!("{message_prefix}HTTP {} at {url}: {text}", fetch_result.status))
                .unwrap_or_else(|| format!("{message_prefix}{text}"));
            set_error_state(&app, status.clone(), message, Some(fetch_result.status));

            if status == usage::AppStatus::AuthRequired && !authenticated_session {
                let _ = windows::open_auth_window(&app, windows::AuthOpenReason::Auth);
            }
        }
        Err(error) => {
            let status = if error == "request_timeout" {
                usage::AppStatus::RequestTimeout
            } else if is_network_failure(&error) {
                usage::AppStatus::Offline
            } else {
                usage::AppStatus::ApiError
            };
            set_error_state(
                &app,
                status.clone(),
                format!("{source} refresh failed: {error}"),
                None,
            );

            let has_usage = state_snapshot(&app).usage.is_some();
            if !has_usage && status != usage::AppStatus::Offline {
                let _ = windows::open_auth_window(&app, windows::AuthOpenReason::Auth);
            }
        }
    }

    run_pending_refresh(&app);
}

pub(crate) fn state_snapshot(app: &tauri::AppHandle) -> app_state::RuntimeState {
    let data = app.state::<AppData>();
    data.lock()
        .map(|state| state.clone())
        .unwrap_or_else(|_| app_state::RuntimeState::new(None, None, app_state::DEFAULT_REFRESH_INTERVAL_MINUTES, false))
}

pub(crate) fn emit_debug_state(app: &tauri::AppHandle) {
    emit_state_changed(app);
}

pub(crate) fn set_refresh_interval(app: &tauri::AppHandle, minutes: u64) -> Result<(), String> {
    if !app_state::REFRESH_INTERVALS.contains(&minutes) {
        return Err("invalid refresh interval".to_string());
    }

    {
        let data = app.state::<AppData>();
        let mut state = data.lock().map_err(|error| error.to_string())?;
        state.refresh_interval_minutes = minutes;
        save_current_store(app, &state)?;
    }
    setup_refresh_timer(app.clone());
    emit_state_changed(app);
    Ok(())
}

pub(crate) fn set_launch_at_login(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        app.autolaunch().enable().map_err(|error| error.to_string())?;
    } else {
        app.autolaunch().disable().map_err(|error| error.to_string())?;
    }

    {
        let data = app.state::<AppData>();
        let mut state = data.lock().map_err(|error| error.to_string())?;
        state.launch_at_login = enabled;
        save_current_store(app, &state)?;
    }
    emit_state_changed(app);
    Ok(())
}

pub(crate) async fn reset_session(app: tauri::AppHandle) -> Result<(), String> {
    // Best-effort cleanup: ignore individual errors
    let _ = windows::clear_tauri_session(&app);
    let _ = store::reset(&app);

    {
        let data = app.state::<AppData>();
        let mut state = data.lock().map_err(|error| error.to_string())?;
        let refresh_interval_minutes = state.refresh_interval_minutes;
        let launch_at_login = state.launch_at_login;
        *state = app_state::RuntimeState::new(None, None, refresh_interval_minutes, launch_at_login);
        state.last_error = Some(app_state::safe_error(
            usage::AppStatus::AuthRequired,
            "ChatGPT session was reset.",
            None,
        ));
    }
    emit_state_changed(&app);

    match windows::open_auth_window(&app, windows::AuthOpenReason::Auth) {
        Ok(()) => Ok(()),
        Err(error) => {
            // Auth window failed — ensure debug window is visible as fallback
            let _ = windows::open_debug_window(&app);
            Err(error)
        }
    }
}

pub(crate) fn show_about(app: &tauri::AppHandle) {
    app.dialog()
        .message(
            "Unofficial local tray app for viewing Codex quota from an authenticated ChatGPT web session.\n\nNo OpenAI or Codex official logos are used.",
        )
        .title(format!("About {}", app_state::APP_NAME))
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::Ok)
        .show(|_| {});
}

fn set_error_state(
    app: &tauri::AppHandle,
    status: usage::AppStatus,
    message: String,
    http_status: Option<u16>,
) {
    {
        let data = app.state::<AppData>();
        let mut state = match data.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        let has_usage = state.usage.is_some();
        state.status = status.clone();
        state.last_error = Some(app_state::safe_error(status, message, http_status));
        state.stale = has_usage;
        state.usage_comparison = None;
        state.is_refreshing = false;
    }
    emit_state_changed(app);
}

fn run_pending_refresh(app: &tauri::AppHandle) {
    let pending = {
        let data = app.state::<AppData>();
        let mut state = match data.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        if state.pending_refresh {
            state.pending_refresh = false;
            true
        } else {
            false
        }
    };

    if pending {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            refresh_usage(app, "manual").await;
        });
    }
}

fn setup_refresh_timer(app: tauri::AppHandle) {
    let minutes = state_snapshot(&app).refresh_interval_minutes;
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(minutes * 60)).await;

            if state_snapshot(&app).refresh_interval_minutes != minutes {
                break;
            }

            refresh_usage(app.clone(), "timer").await;
        }
    });
}

fn emit_state_changed(app: &tauri::AppHandle) {
    tray::rebuild_tray(app);
    let _ = app.emit(
        app_state::DEBUG_STATE_CHANGED,
        debug::build_debug_state(&state_snapshot(app), Local::now()),
    );
}

fn save_current_store(app: &tauri::AppHandle, state: &app_state::RuntimeState) -> Result<(), String> {
    store::save(
        app,
        &store::StoreShape {
            refresh_interval_minutes: state.refresh_interval_minutes,
            launch_at_login: state.launch_at_login,
            last_known_usage: state.usage.clone(),
            last_updated_at: state.last_updated_at.clone(),
        },
    )
}

fn is_network_failure(message: &str) -> bool {
    message.contains("ERR_INTERNET_DISCONNECTED")
        || message.contains("ERR_NETWORK")
        || message.contains("ERR_NAME_NOT_RESOLVED")
        || message.contains("network")
}
