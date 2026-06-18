use std::time::Duration;

use tauri::{
    webview::{NewWindowResponse, WebviewWindow},
    AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;

use crate::{
    app_state::{ANALYTICS_URL, APP_NAME},
    store,
    AppData,
};

pub const DEBUG_LABEL: &str = "debug";
pub const AUTH_LABEL: &str = "auth";
pub const HIDDEN_LABEL: &str = "chatgpt-hidden";

pub fn open_debug_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(DEBUG_LABEL) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        crate::emit_debug_state(app);
        return Ok(());
    }

    let app_handle = app.clone();
    let window = WebviewWindowBuilder::new(app, DEBUG_LABEL, WebviewUrl::App("index.html".into()))
        .title(format!("{APP_NAME} - Debug details"))
        .inner_size(840.0, 760.0)
        .min_inner_size(720.0, 560.0)
        .visible(true)
        .on_navigation({
            let app_handle = app.clone();
            move |url| allow_local_debug_navigation(&app_handle, url)
        })
        .on_new_window({
            let app_handle = app.clone();
            move |url, _features| {
                let _ = app_handle.opener().open_url(url.as_str(), None::<&str>);
                NewWindowResponse::Deny
            }
        })
        .build()
        .map_err(|error| error.to_string())?;

    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            let data = app_handle.state::<AppData>();
            let is_quitting = data.lock().map(|state| state.is_quitting).unwrap_or(false);
            if !is_quitting {
                api.prevent_close();
                if let Some(window) = app_handle.get_webview_window(DEBUG_LABEL) {
                    let _ = window.hide();
                }
            }
        }
    });
    crate::emit_debug_state(app);
    Ok(())
}

pub fn open_auth_window(app: &AppHandle, reason: AuthOpenReason) -> Result<(), String> {
    {
        let data = app.state::<AppData>();
        if let Ok(mut state) = data.lock() {
            state.auto_close_auth_after_refresh = matches!(reason, AuthOpenReason::Auth);
        };
    }

    if let Some(window) = app.get_webview_window(AUTH_LABEL) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let app_for_page_load = app.clone();
    WebviewWindowBuilder::new(
        app,
        AUTH_LABEL,
        WebviewUrl::External(Url::parse(ANALYTICS_URL).map_err(|error| error.to_string())?),
    )
    .title(format!("{APP_NAME} - ChatGPT"))
    .inner_size(1160.0, 820.0)
    .visible(true)
    .data_directory(store::chatgpt_data_dir(app))
    .on_navigation(|url| allowed_auth_url(url))
    .on_new_window({
        let app_handle = app.clone();
        move |url, _features| {
            let _ = app_handle.opener().open_url(url.as_str(), None::<&str>);
            NewWindowResponse::Deny
        }
    })
    .on_page_load(move |window, payload| {
        if payload.url().host_str() == Some("chatgpt.com") {
            let app_handle = app_for_page_load.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(crate::app_state::CHATGPT_APP_READY_DELAY_MS)).await;
                crate::refresh_usage(app_handle, "manual").await;
            });
        }
        let _ = window.set_title(&format!("{APP_NAME} - ChatGPT"));
    })
    .build()
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn get_hidden_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(HIDDEN_LABEL) {
        return Ok(window);
    }

    WebviewWindowBuilder::new(
        app,
        HIDDEN_LABEL,
        WebviewUrl::External(Url::parse(ANALYTICS_URL).map_err(|error| error.to_string())?),
    )
    .title(format!("{APP_NAME} - ChatGPT hidden"))
    .inner_size(800.0, 600.0)
    .visible(false)
    .data_directory(store::chatgpt_data_dir(app))
    .on_navigation(|url| allowed_auth_url(url))
    .on_new_window({
        let app_handle = app.clone();
        move |url, _features| {
            let _ = app_handle.opener().open_url(url.as_str(), None::<&str>);
            NewWindowResponse::Deny
        }
    })
    .build()
    .map_err(|error| error.to_string())
}

pub fn close_auto_auth_window_after_refresh(app: &AppHandle) {
    let should_close = {
        let data = app.state::<AppData>();
        let mut state = match data.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        if state.auto_close_auth_after_refresh {
            state.auto_close_auth_after_refresh = false;
            true
        } else {
            false
        }
    };

    if should_close {
        if let Some(window) = app.get_webview_window(AUTH_LABEL) {
            let _ = window.close();
        }
    }
}

pub fn clear_tauri_session(app: &AppHandle) -> Result<(), String> {
    for label in [AUTH_LABEL, HIDDEN_LABEL] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.clear_all_browsing_data();
            let _ = window.close();
        }
    }

    let dir = store::chatgpt_data_dir(app);
    if dir.exists() {
        std::fs::remove_dir_all(dir).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[derive(Clone, Copy)]
pub enum AuthOpenReason {
    Auth,
    User,
}

pub fn allowed_auth_url(url: &Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }

    match url.host_str() {
        Some("chatgpt.com" | "chat.openai.com" | "openai.com") => true,
        Some(host) => host.ends_with(".openai.com"),
        None => false,
    }
}

fn allow_local_debug_navigation(app: &AppHandle, url: &Url) -> bool {
    if url.scheme() == "tauri" || (cfg!(dev) && url.host_str() == Some("127.0.0.1")) {
        return true;
    }

    let _ = app.opener().open_url(url.as_str(), None::<&str>);
    false
}
