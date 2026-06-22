use serde::{Deserialize, Serialize};

use crate::usage::{AppStatus, CodexUsage, UsageComparison};

pub const APP_NAME: &str = "Codex Quota";
pub const ANALYTICS_URL: &str = "https://chatgpt.com/codex/cloud/settings/analytics";
pub const ANALYTICS_PATH: &str = "/codex/cloud/settings/analytics";
pub const AUTH_LOGIN_URL: &str =
    "https://chatgpt.com/auth/login?next=%2Fcodex%2Fcloud%2Fsettings%2Fanalytics";
pub const REFRESH_TIMEOUT_MS: u64 = 30_000;
pub const CHATGPT_APP_READY_DELAY_MS: u64 = 4_000;
pub const CHATGPT_SESSION_WAIT_MS: u64 = 20_000;
pub const DEFAULT_REFRESH_INTERVAL_MINUTES: u64 = 5;
pub const REFRESH_INTERVALS: [u64; 4] = [1, 5, 15, 30];
pub const DEBUG_STATE_CHANGED: &str = "debug_state_changed";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SanitizedError {
    pub status: AppStatus,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    pub occurred_at: String,
}

#[derive(Clone, Debug)]
pub struct RuntimeState {
    pub status: AppStatus,
    pub usage: Option<CodexUsage>,
    pub usage_comparison: Option<UsageComparison>,
    pub last_updated_at: Option<String>,
    pub last_error: Option<SanitizedError>,
    pub stale: bool,
    pub refresh_interval_minutes: u64,
    pub launch_at_login: bool,
    pub is_refreshing: bool,
    pub pending_refresh: bool,
    pub auto_close_auth_after_refresh: bool,
    pub is_quitting: bool,
}

impl RuntimeState {
    pub fn new(
        usage: Option<CodexUsage>,
        last_updated_at: Option<String>,
        refresh_interval_minutes: u64,
        launch_at_login: bool,
    ) -> Self {
        let status = usage
            .as_ref()
            .map(crate::usage::classify_usage)
            .unwrap_or(AppStatus::AuthRequired);

        Self {
            status,
            usage,
            usage_comparison: None,
            last_updated_at,
            last_error: None,
            stale: false,
            refresh_interval_minutes,
            launch_at_login,
            is_refreshing: false,
            pending_refresh: false,
            auto_close_auth_after_refresh: false,
            is_quitting: false,
        }
    }
}

pub fn safe_error(status: AppStatus, message: impl Into<String>, http_status: Option<u16>) -> SanitizedError {
    SanitizedError {
        status,
        message: message.into(),
        http_status,
        occurred_at: crate::time::now_iso(),
    }
}
