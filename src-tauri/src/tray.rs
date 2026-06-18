use chrono::Local;
use tauri::{
    image::Image,
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::{
    app_state::{APP_NAME, REFRESH_INTERVALS},
    summary::{build_usage_summary, format_delta, format_percent},
    time::{format_compact_last_updated, format_last_updated, format_relative_reset, format_reset_with_relative, format_weekly_reset},
    usage::AppStatus,
    windows::{self, AuthOpenReason},
    AppData,
};

const TRAY_ID: &str = "main-tray";

pub fn create_tray(app: &AppHandle) -> Result<(), String> {
    let menu = build_menu(app)?;
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(tray_image(app)?)
        .icon_as_template(cfg!(target_os = "macos") && !is_error_status(&current_status(app)))
        .tooltip(tooltip_text(app))
        .title(short_title(app))
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| handle_menu_event(app, event.id.as_ref()))
        .build(app)
        .map_err(|error| error.to_string())?;

    if cfg!(target_os = "macos") {
        let _ = tray.set_title(Some(short_title(app)));
    }

    Ok(())
}

pub fn rebuild_tray(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };

    if let Ok(icon) = tray_image(app) {
        if cfg!(target_os = "macos") {
            let _ = tray.set_icon_with_as_template(Some(icon), !is_error_status(&current_status(app)));
        } else {
            let _ = tray.set_icon(Some(icon));
        }
    }

    let _ = tray.set_tooltip(Some(tooltip_text(app)));
    if cfg!(target_os = "macos") {
        let _ = tray.set_title(Some(short_title(app)));
    }
    if let Ok(menu) = build_menu(app) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "refresh" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                crate::refresh_usage(app, "manual").await;
            });
        }
        "copy_summary" => {
            let state = crate::state_snapshot(app);
            let text = build_usage_summary(&state, Local::now());
            let _ = app.clipboard().write_text(text);
        }
        "analytics" => {
            let _ = windows::open_auth_window(app, AuthOpenReason::User);
        }
        "debug" => {
            let _ = windows::open_debug_window(app);
        }
        "launch_at_login" => {
            let enabled = {
                let data = app.state::<AppData>();
                data.lock().map(|state| !state.launch_at_login).unwrap_or(false)
            };
            let _ = crate::set_launch_at_login(app, enabled);
        }
        "reset_session" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = crate::reset_session(app).await;
            });
        }
        "about" => crate::show_about(app),
        "quit" => {
            if let Ok(mut state) = app.state::<AppData>().lock() {
                state.is_quitting = true;
            }
            app.exit(0);
        }
        value if value.starts_with("interval_") => {
            if let Some(minutes) = value.strip_prefix("interval_").and_then(|raw| raw.parse::<u64>().ok()) {
                let _ = crate::set_refresh_interval(app, minutes);
            }
        }
        _ => {}
    }
}

fn build_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, String> {
    let state = crate::state_snapshot(app);
    let menu = Menu::new(app).map_err(|error| error.to_string())?;

    append_label(app, &menu, "app_name", APP_NAME)?;
    append_label(
        app,
        &menu,
        "status",
        &format!(
            "Status: {}{}",
            state.status.as_str(),
            if state.is_refreshing { " (refreshing)" } else { "" }
        ),
    )?;

    if let Some(usage) = &state.usage {
        if let Some(email) = &usage.email {
            append_label(app, &menu, "account", &format!("Acct: {email}"))?;
        }
        if let Some(plan_type) = &usage.plan_type {
            append_label(app, &menu, "plan", &format!("Plan: {plan_type}"))?;
        }
        append_label(
            app,
            &menu,
            "primary",
            &compact_quota_line("5h", &usage.rate_limit.primary_window),
        )?;
        append_label(
            app,
            &menu,
            "weekly",
            &compact_quota_line("Week", &usage.rate_limit.secondary_window),
        )?;
        append_label(
            app,
            &menu,
            "credits",
            &format!(
                "Credits: {}",
                if usage.credits.unlimited {
                    "Unlimited".to_string()
                } else {
                    usage
                        .credits
                        .balance
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| "Unknown".to_string())
                }
            ),
        )?;

        if let Some(comparison) = &state.usage_comparison {
            if !state.stale {
                append_label(
                    app,
                    &menu,
                    "change",
                    &format!(
                        "Change: 5h {}, W {}",
                        format_delta(comparison.primary_window_left_percent_delta),
                        format_delta(comparison.secondary_window_left_percent_delta)
                    ),
                )?;
            }
        }
    } else {
        append_label(app, &menu, "quota_unknown", "Quota: Unknown")?;
    }

    append_label(
        app,
        &menu,
        "updated",
        &format!("Updated: {}", format_compact_last_updated(state.last_updated_at.as_deref())),
    )?;
    if state.stale {
        append_label(app, &menu, "stale", &stale_label(&state.last_updated_at))?;
    }

    append_separator(app, &menu)?;
    append_action(app, &menu, "refresh", "Refresh")?;
    append_action(app, &menu, "copy_summary", "Copy summary")?;
    append_action(app, &menu, "analytics", "Analytics")?;
    append_action(app, &menu, "debug", "Debug")?;
    append_separator(app, &menu)?;

    let interval_items = REFRESH_INTERVALS
        .iter()
        .map(|minutes| {
            CheckMenuItem::with_id(
                app,
                format!("interval_{minutes}"),
                format!("{minutes} {}", if *minutes == 1 { "minute" } else { "minutes" }),
                true,
                state.refresh_interval_minutes == *minutes,
                None::<&str>,
            )
            .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let interval_refs = interval_items
        .iter()
        .map(|item| item as &dyn IsMenuItem<tauri::Wry>)
        .collect::<Vec<_>>();
    let interval = Submenu::with_items(app, "Interval", true, &interval_refs)
        .map_err(|error| error.to_string())?;
    menu.append(&interval).map_err(|error| error.to_string())?;

    let launch = CheckMenuItem::with_id(
        app,
        "launch_at_login",
        "Launch at login",
        true,
        state.launch_at_login,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    menu.append(&launch).map_err(|error| error.to_string())?;

    append_action(app, &menu, "reset_session", "Reset session")?;
    append_action(app, &menu, "about", "About")?;
    append_separator(app, &menu)?;
    append_action(app, &menu, "quit", "Quit")?;

    Ok(menu)
}

fn append_label(app: &AppHandle, menu: &Menu<tauri::Wry>, id: &str, text: &str) -> Result<(), String> {
    let item = MenuItem::with_id(app, id, text, false, None::<&str>).map_err(|error| error.to_string())?;
    menu.append(&item).map_err(|error| error.to_string())
}

fn append_action(app: &AppHandle, menu: &Menu<tauri::Wry>, id: &str, text: &str) -> Result<(), String> {
    let item = MenuItem::with_id(app, id, text, true, None::<&str>).map_err(|error| error.to_string())?;
    menu.append(&item).map_err(|error| error.to_string())
}

fn append_separator(app: &AppHandle, menu: &Menu<tauri::Wry>) -> Result<(), String> {
    let item = PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?;
    menu.append(&item).map_err(|error| error.to_string())
}

fn tray_image(app: &AppHandle) -> Result<Image<'static>, String> {
    let status = current_status(app);
    let bytes = if is_error_status(&status) {
        include_bytes!("../../build/assets/tray-error.png").as_slice()
    } else {
        include_bytes!("../../build/assets/tray-normal.png").as_slice()
    };
    Image::from_bytes(bytes).map_err(|error| error.to_string())
}

fn current_status(app: &AppHandle) -> AppStatus {
    crate::state_snapshot(app).status
}

fn is_error_status(status: &AppStatus) -> bool {
    matches!(
        status,
        AppStatus::AuthRequired
            | AppStatus::RequestTimeout
            | AppStatus::Offline
            | AppStatus::ApiError
            | AppStatus::ParseError
    )
}

fn short_title(app: &AppHandle) -> String {
    let state = crate::state_snapshot(app);
    let Some(usage) = state.usage else {
        return "Codex ?".to_string();
    };
    format!(
        "Codex 5h {} | Weekly {}",
        format_percent(usage.rate_limit.primary_window.left_percent),
        format_percent(usage.rate_limit.secondary_window.left_percent)
    )
}

fn compact_quota_line(label: &str, window: &crate::usage::UsageWindow) -> String {
    format!(
        "{}: {} left, reset {}",
        label,
        format_percent(window.left_percent),
        compact_reset_text(window)
    )
}

fn compact_reset_text(window: &crate::usage::UsageWindow) -> String {
    format_relative_reset(window.reset_at, Local::now()).replace("in ", "")
}

fn tooltip_text(app: &AppHandle) -> String {
    if cfg!(target_os = "windows") {
        return windows_tooltip_text(app);
    }

    let state = crate::state_snapshot(app);
    let mut lines = vec![APP_NAME.to_string(), status_line(&state)];

    if let Some(usage) = &state.usage {
        let primary = &usage.rate_limit.primary_window;
        let weekly = &usage.rate_limit.secondary_window;
        let now = Local::now();
        let primary_absolute = crate::time::format_primary_reset(primary.reset_at, now);
        let weekly_absolute = format_weekly_reset(weekly.reset_at);

        lines.push(format!(
            "5h: {} left, reset {}",
            format_percent(primary.left_percent),
            format_reset_with_relative(primary.reset_at, &primary_absolute, now)
        ));
        lines.push(format!(
            "Weekly: {} left, reset {}",
            format_percent(weekly.left_percent),
            format_reset_with_relative(weekly.reset_at, &weekly_absolute, now)
        ));
    }

    if state.stale {
        lines.push(stale_label(&state.last_updated_at));
    }

    lines.push(format!("Last updated: {}", format_last_updated(state.last_updated_at.as_deref())));
    if state.usage.is_none() {
        if let Some(error) = &state.last_error {
            lines.push(format!("Last error: {}", error.status.as_str()));
        }
    }

    lines.join("\n")
}

fn windows_tooltip_text(app: &AppHandle) -> String {
    let state = crate::state_snapshot(app);
    let mut state_text = format!("Codex {}", compact_status_text(&state.status));
    if state.stale {
        state_text.push_str(" S");
    }
    if state.is_refreshing {
        state_text.push_str(" R");
    }
    let mut lines = vec![state_text];

    if let Some(usage) = &state.usage {
        lines.push(format!(
            "5h {} r {}",
            format_percent(usage.rate_limit.primary_window.left_percent),
            windows_reset_text(&usage.rate_limit.primary_window)
        ));
        lines.push(format!(
            "W {} r {}",
            format_percent(usage.rate_limit.secondary_window.left_percent),
            windows_reset_text(&usage.rate_limit.secondary_window)
        ));
    } else if let Some(error) = &state.last_error {
        lines.push(format!("Error {}", error.status.as_str()));
    }

    lines.push(format!(
        "Upd {}",
        windows_last_updated_text(state.last_updated_at.as_deref())
    ));
    lines.join("\n")
}

fn compact_status_text(status: &AppStatus) -> &'static str {
    match status {
        AppStatus::Ok => "OK",
        AppStatus::LowQuota => "Low",
        AppStatus::CriticalQuota => "Critical",
        AppStatus::AuthRequired => "Auth",
        AppStatus::RequestTimeout => "Timeout",
        AppStatus::Offline => "Offline",
        AppStatus::ApiError => "API error",
        AppStatus::ParseError => "Parse error",
    }
}

fn windows_reset_text(window: &crate::usage::UsageWindow) -> String {
    compact_reset_text(window).replace(' ', "")
}

fn windows_last_updated_text(iso_string: Option<&str>) -> String {
    format_compact_last_updated(iso_string).replace(',', "")
}

fn status_line(state: &crate::app_state::RuntimeState) -> String {
    format!(
        "Status: {}{}{}",
        state.status.as_str(),
        if state.stale { " (showing stale data)" } else { "" },
        if state.is_refreshing { " (refreshing)" } else { "" }
    )
}

fn stale_label(last_updated_at: &Option<String>) -> String {
    match last_updated_at.as_deref() {
        Some(value) => format!("Showing stale data from {}", format_last_updated(Some(value))),
        None => "Showing stale data".to_string(),
    }
}
