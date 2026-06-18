use chrono::{DateTime, Local};
use serde::Serialize;

use crate::{
    app_state::{RuntimeState, SanitizedError},
    summary::format_usage_comparison,
    time::{format_last_updated, format_primary_reset, format_weekly_reset},
    usage::{AppStatus, CodexUsage, UsageComparison, UsageWindow},
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindowView {
    pub used_percent: f64,
    pub left_percent: f64,
    pub limit_window_seconds: u64,
    pub reset_after_seconds: u64,
    pub reset_at: u64,
    pub reset_text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsageView {
    pub user_id: Option<String>,
    pub account_id: Option<String>,
    pub email: Option<String>,
    pub plan_type: Option<String>,
    pub rate_limit: RateLimitView,
    pub credits: CreditsView,
    pub rate_limit_reached_type: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitView {
    pub allowed: bool,
    pub limit_reached: bool,
    pub primary_window: UsageWindowView,
    pub secondary_window: UsageWindowView,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditsView {
    pub has_credits: bool,
    pub unlimited: bool,
    pub balance: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugState {
    pub status: AppStatus,
    pub usage: Option<CodexUsageView>,
    pub usage_comparison: Option<UsageComparison>,
    pub usage_comparison_text: Option<String>,
    pub last_updated_at: Option<String>,
    pub last_updated_text: String,
    pub last_error: Option<SanitizedError>,
    pub stale: bool,
    pub refresh_interval_minutes: u64,
    pub launch_at_login: bool,
    pub is_refreshing: bool,
    pub redacted_json: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DebugStateForJson {
    status: AppStatus,
    usage: Option<CodexUsageView>,
    usage_comparison: Option<UsageComparison>,
    usage_comparison_text: Option<String>,
    last_updated_at: Option<String>,
    last_updated_text: String,
    last_error: Option<SanitizedError>,
    stale: bool,
    refresh_interval_minutes: u64,
    launch_at_login: bool,
    is_refreshing: bool,
}

pub fn build_debug_state(state: &RuntimeState, now: DateTime<Local>) -> DebugState {
    let json_state = build_debug_state_for_json(state, now, true);
    let redacted_json = serde_json::to_string_pretty(&json_state).unwrap_or_else(|_| "{}".to_string());
    let public_state = build_debug_state_for_json(state, now, false);

    DebugState {
        status: public_state.status,
        usage: public_state.usage,
        usage_comparison: public_state.usage_comparison,
        usage_comparison_text: public_state.usage_comparison_text,
        last_updated_at: public_state.last_updated_at,
        last_updated_text: public_state.last_updated_text,
        last_error: public_state.last_error,
        stale: public_state.stale,
        refresh_interval_minutes: public_state.refresh_interval_minutes,
        launch_at_login: public_state.launch_at_login,
        is_refreshing: public_state.is_refreshing,
        redacted_json,
    }
}

pub fn to_debug_json(state: &RuntimeState, now: DateTime<Local>) -> String {
    let json_state = build_debug_state_for_json(state, now, true);
    serde_json::to_string_pretty(&json_state).unwrap_or_else(|_| "{}".to_string())
}

fn build_debug_state_for_json(
    state: &RuntimeState,
    now: DateTime<Local>,
    redacted: bool,
) -> DebugStateForJson {
    let usage_comparison_text = state.usage_comparison.as_ref().map(format_usage_comparison);
    DebugStateForJson {
        status: state.status.clone(),
        usage: state
            .usage
            .as_ref()
            .map(|usage| usage_view(usage, now, redacted)),
        usage_comparison: state.usage_comparison.clone(),
        usage_comparison_text,
        last_updated_at: state.last_updated_at.clone(),
        last_updated_text: format_last_updated(state.last_updated_at.as_deref()),
        last_error: state.last_error.clone(),
        stale: state.stale,
        refresh_interval_minutes: state.refresh_interval_minutes,
        launch_at_login: state.launch_at_login,
        is_refreshing: state.is_refreshing,
    }
}

fn usage_view(usage: &CodexUsage, now: DateTime<Local>, redacted: bool) -> CodexUsageView {
    CodexUsageView {
        user_id: redact_id(usage.user_id.as_deref(), redacted),
        account_id: redact_id(usage.account_id.as_deref(), redacted),
        email: redact_email(usage.email.as_deref(), redacted),
        plan_type: usage.plan_type.clone(),
        rate_limit: RateLimitView {
            allowed: usage.rate_limit.allowed,
            limit_reached: usage.rate_limit.limit_reached,
            primary_window: window_view(&usage.rate_limit.primary_window, true, now),
            secondary_window: window_view(&usage.rate_limit.secondary_window, false, now),
        },
        credits: CreditsView {
            has_credits: usage.credits.has_credits,
            unlimited: usage.credits.unlimited,
            balance: usage.credits.balance,
        },
        rate_limit_reached_type: usage.rate_limit_reached_type.clone(),
    }
}

fn window_view(window: &UsageWindow, primary: bool, now: DateTime<Local>) -> UsageWindowView {
    UsageWindowView {
        used_percent: window.used_percent,
        left_percent: window.left_percent,
        limit_window_seconds: window.limit_window_seconds,
        reset_after_seconds: window.reset_after_seconds,
        reset_at: window.reset_at,
        reset_text: if primary {
            format_primary_reset(window.reset_at, now)
        } else {
            format_weekly_reset(window.reset_at)
        },
    }
}

fn redact_id(value: Option<&str>, redacted: bool) -> Option<String> {
    value.map(|text| {
        if redacted {
            "[redacted]".to_string()
        } else {
            text.to_string()
        }
    })
}

fn redact_email(value: Option<&str>, redacted: bool) -> Option<String> {
    value.map(|email| {
        if !redacted {
            return email.to_string();
        }

        let Some((local, domain)) = email.split_once('@') else {
            return "[redacted]".to_string();
        };
        let first = local.chars().next().unwrap_or_default();
        format!("{first}***@{domain}")
    })
}
