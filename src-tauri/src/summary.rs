use chrono::{DateTime, Local};

use crate::{
    app_state::RuntimeState,
    time::{format_last_updated, format_primary_reset, format_reset_with_relative, format_weekly_reset},
    usage::UsageComparison,
};

pub fn format_percent(value: f64) -> String {
    format!("{}%", value.round() as i64)
}

pub fn format_delta(value: f64) -> String {
    let rounded = value.round() as i64;
    format!("{}{}%", if rounded > 0 { "+" } else { "" }, rounded)
}

pub fn format_usage_comparison(comparison: &UsageComparison) -> String {
    format!(
        "Change: 5h {}, Weekly {}",
        format_delta(comparison.primary_window_left_percent_delta),
        format_delta(comparison.secondary_window_left_percent_delta)
    )
}

pub fn build_usage_summary(state: &RuntimeState, now: DateTime<Local>) -> String {
    let mut lines = vec![format!(
        "Codex Quota: {}{}",
        state.status.as_str(),
        if state.stale { " (showing stale data)" } else { "" }
    )];

    if let Some(usage) = &state.usage {
        let primary = &usage.rate_limit.primary_window;
        let weekly = &usage.rate_limit.secondary_window;
        let primary_absolute = format_primary_reset(primary.reset_at, now);
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

        if let Some(comparison) = &state.usage_comparison {
            lines.push(format_usage_comparison(comparison));
        }
    } else if let Some(error) = &state.last_error {
        lines.push(format!("Last error: {}: {}", error.status.as_str(), error.message));
    }

    lines.push(format!(
        "Last updated: {}",
        format_last_updated(state.last_updated_at.as_deref())
    ));
    lines.join("\n")
}
