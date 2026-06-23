use chrono::{Local, TimeZone};
use serde_json::{json, Value};

use crate::{
    app_state::RuntimeState,
    debug::to_debug_json,
    chatgpt::decode_eval_result,
    summary::build_usage_summary,
    time::{
        format_compact_last_updated, format_primary_reset, format_relative_reset,
        format_reset_with_relative, format_weekly_reset,
    },
    usage::{
        classify_usage, compare_usage, left_percent_from_used, map_http_status_to_app_status,
        parse_usage_response, AppStatus,
    },
};

fn response(overrides: Value) -> Value {
    let mut base = json!({
        "user_id": "user_123",
        "account_id": "acct_123",
        "email": "person@example.com",
        "plan_type": "pro",
        "rate_limit": {
            "allowed": true,
            "limit_reached": false,
            "primary_window": {
                "used_percent": 4,
                "limit_window_seconds": 18000,
                "reset_after_seconds": 1200,
                "reset_at": 1781701320
            },
            "secondary_window": {
                "used_percent": 64,
                "limit_window_seconds": 604800,
                "reset_after_seconds": 86400,
                "reset_at": 1781737320
            }
        },
        "credits": {
            "has_credits": true,
            "unlimited": false,
            "balance": 12
        },
        "rate_limit_reached_type": null,
        "extra_field": "allowed"
    });

    merge(&mut base, overrides);
    base
}

fn merge(base: &mut Value, overrides: Value) {
    let (Some(base), Some(overrides)) = (base.as_object_mut(), overrides.as_object()) else {
        return;
    };

    for (key, value) in overrides {
        base.insert(key.clone(), value.clone());
    }
}

#[test]
fn parses_and_maps_usage_response() {
    let usage = parse_usage_response(response(json!({}))).unwrap();

    assert_eq!(usage.email.as_deref(), Some("person@example.com"));
    assert_eq!(usage.user_id.as_deref(), Some("user_123"));
    assert_eq!(usage.account_id.as_deref(), Some("acct_123"));
    assert_eq!(usage.plan_type.as_deref(), Some("pro"));
    assert_eq!(usage.rate_limit.primary_window.used_percent, 4.0);
    assert_eq!(usage.rate_limit.primary_window.left_percent, 96.0);
    assert_eq!(usage.rate_limit.secondary_window.left_percent, 36.0);
    assert_eq!(usage.credits.balance, Some(12.0));
}

#[test]
fn accepts_credit_balance_variants() {
    let numeric_string = parse_usage_response(response(json!({
        "credits": {
            "has_credits": true,
            "unlimited": false,
            "balance": "12.5"
        }
    })))
    .unwrap();
    assert_eq!(numeric_string.credits.balance, Some(12.5));

    let null_balance = parse_usage_response(response(json!({
        "credits": {
            "has_credits": true,
            "unlimited": false,
            "balance": null
        }
    })))
    .unwrap();
    assert_eq!(null_balance.credits.balance, None);
}

#[test]
fn accepts_object_typed_optional_string_fields() {
    let plan_type_object = parse_usage_response(response(json!({
        "plan_type": {"type": "pro"},
        "rate_limit_reached_type": {"name": "monthly_cap"}
    })))
    .unwrap();
    assert_eq!(plan_type_object.plan_type.as_deref(), Some("pro"));
    assert_eq!(
        plan_type_object.rate_limit_reached_type.as_deref(),
        Some("monthly_cap")
    );

    let email_object = parse_usage_response(response(json!({
        "email": {"value": "test@example.com"},
        "user_id": {"id": "u_456"},
        "account_id": {"id": "a_789"}
    })))
    .unwrap();
    assert_eq!(email_object.email.as_deref(), Some("test@example.com"));
    assert_eq!(email_object.user_id.as_deref(), Some("u_456"));
    assert_eq!(email_object.account_id.as_deref(), Some("a_789"));

    let null_fields = parse_usage_response(response(json!({
        "plan_type": null,
        "rate_limit_reached_type": null,
        "email": null,
        "user_id": null,
        "account_id": null
    })))
    .unwrap();
    assert_eq!(null_fields.plan_type, None);
    assert_eq!(null_fields.rate_limit_reached_type, None);
    assert_eq!(null_fields.email, None);
    assert_eq!(null_fields.user_id, None);
    assert_eq!(null_fields.account_id, None);
}

#[test]
fn rejects_missing_or_invalid_required_fields() {
    assert!(parse_usage_response(response(json!({
        "rate_limit": {
            "allowed": true,
            "limit_reached": false,
            "primary_window": {
                "limit_window_seconds": 18000,
                "reset_after_seconds": 1200,
                "reset_at": 1781701320
            },
            "secondary_window": {
                "used_percent": 64,
                "limit_window_seconds": 604800,
                "reset_after_seconds": 86400,
                "reset_at": 1781737320
            }
        }
    })))
    .is_err());

    assert!(parse_usage_response(response(json!({
        "credits": {
            "has_credits": true,
            "unlimited": false,
            "balance": "not-a-number"
        }
    })))
    .is_err());
}

#[test]
fn clamps_remaining_percent() {
    assert_eq!(left_percent_from_used(4.0), 96.0);
    assert_eq!(left_percent_from_used(100.0), 0.0);
    assert_eq!(left_percent_from_used(120.0), 0.0);
    assert_eq!(left_percent_from_used(-10.0), 100.0);
}

#[test]
fn classifies_status_from_usage() {
    assert_eq!(classify_usage(&parse_usage_response(response(json!({}))).unwrap()), AppStatus::Ok);
    assert_eq!(
        classify_usage(&parse_usage_response(response(json!({
            "rate_limit": {
                "allowed": true,
                "limit_reached": false,
                "primary_window": {
                    "used_percent": 80,
                    "limit_window_seconds": 18000,
                    "reset_after_seconds": 1200,
                    "reset_at": 1781701320
                },
                "secondary_window": {
                    "used_percent": 64,
                    "limit_window_seconds": 604800,
                    "reset_after_seconds": 86400,
                    "reset_at": 1781737320
                }
            }
        })))
        .unwrap()),
        AppStatus::LowQuota
    );
    assert_eq!(
        classify_usage(&parse_usage_response(response(json!({
            "rate_limit": {
                "allowed": true,
                "limit_reached": false,
                "primary_window": {
                    "used_percent": 4,
                    "limit_window_seconds": 18000,
                    "reset_after_seconds": 1200,
                    "reset_at": 1781701320
                },
                "secondary_window": {
                    "used_percent": 95,
                    "limit_window_seconds": 604800,
                    "reset_after_seconds": 86400,
                    "reset_at": 1781737320
                }
            }
        })))
        .unwrap()),
        AppStatus::CriticalQuota
    );
    assert_eq!(
        classify_usage(&parse_usage_response(response(json!({
            "rate_limit": {
                "allowed": true,
                "limit_reached": true,
                "primary_window": {
                    "used_percent": 4,
                    "limit_window_seconds": 18000,
                    "reset_after_seconds": 1200,
                    "reset_at": 1781701320
                },
                "secondary_window": {
                    "used_percent": 64,
                    "limit_window_seconds": 604800,
                    "reset_after_seconds": 86400,
                    "reset_at": 1781737320
                }
            }
        })))
        .unwrap()),
        AppStatus::CriticalQuota
    );
}

#[test]
fn compares_current_usage_to_previous_in_memory_snapshot() {
    let previous = parse_usage_response(response(json!({}))).unwrap();
    let current = parse_usage_response(response(json!({
        "rate_limit": {
            "allowed": true,
            "limit_reached": false,
            "primary_window": {
                "used_percent": 20,
                "limit_window_seconds": 18000,
                "reset_after_seconds": 1200,
                "reset_at": 1781701320
            },
            "secondary_window": {
                "used_percent": 60,
                "limit_window_seconds": 604800,
                "reset_after_seconds": 86400,
                "reset_at": 1781737320
            }
        }
    })))
    .unwrap();

    let comparison = compare_usage(&previous, &current);
    assert_eq!(comparison.primary_window_left_percent_delta, -16.0);
    assert_eq!(comparison.secondary_window_left_percent_delta, 4.0);
}

#[test]
fn formats_reset_times() {
    let now = Local.with_ymd_and_hms(2026, 6, 17, 8, 0, 0).single().unwrap();
    let reset_today = Local.with_ymd_and_hms(2026, 6, 17, 10, 22, 0).single().unwrap();
    let reset_tomorrow = Local.with_ymd_and_hms(2026, 6, 18, 10, 22, 0).single().unwrap();
    let reset_relative = Local.with_ymd_and_hms(2026, 6, 17, 10, 14, 0).single().unwrap();
    let reset_long = Local.with_ymd_and_hms(2026, 6, 20, 12, 0, 0).single().unwrap();
    let passed = Local.with_ymd_and_hms(2026, 6, 17, 7, 59, 0).single().unwrap();

    assert_eq!(format_primary_reset(reset_today.timestamp() as u64, now), "10:22");
    assert_eq!(
        format_primary_reset(reset_tomorrow.timestamp() as u64, now),
        "Jun 18, 10:22"
    );
    assert_eq!(format_weekly_reset(reset_tomorrow.timestamp() as u64), "Jun 18, 10:22");
    assert_eq!(
        format_relative_reset(reset_relative.timestamp() as u64, now),
        "in 2h 14m"
    );
    assert_eq!(
        format_reset_with_relative(reset_relative.timestamp() as u64, "10:14", now),
        "in 2h 14m at 10:14"
    );
    assert_eq!(format_relative_reset(reset_long.timestamp() as u64, now), "in 3d 4h");
    assert_eq!(format_relative_reset(passed.timestamp() as u64, now), "passed");
}

#[test]
fn formats_compact_last_updated() {
    let updated_at = Local
        .with_ymd_and_hms(2026, 6, 18, 9, 13, 36)
        .single()
        .unwrap()
        .to_rfc3339();

    assert_eq!(format_compact_last_updated(Some(&updated_at)), "Jun 18, 09:13");
}

#[test]
fn redacts_copied_debug_json() {
    let usage = parse_usage_response(response(json!({}))).unwrap();
    let state = RuntimeState {
        status: AppStatus::Ok,
        usage: Some(usage),
        usage_comparison: None,
        last_updated_at: Some("2026-06-18T00:00:00.000Z".to_string()),
        last_error: None,
        stale: false,
        refresh_interval_minutes: 5,
        launch_at_login: false,
        is_refreshing: false,
        pending_refresh: false,
        auto_close_auth_after_refresh: false,
        is_quitting: false,
    };

    let debug_json = to_debug_json(&state, Local::now());

    assert!(debug_json.contains("p***@example.com"));
    assert!(!debug_json.contains("person@example.com"));
    assert!(!debug_json.contains("user_123"));
    assert!(!debug_json.contains("acct_123"));
}

#[test]
fn builds_summary_without_account_identifiers() {
    let usage = parse_usage_response(response(json!({}))).unwrap();
    let mut state = RuntimeState::new(Some(usage.clone()), Some("2026-06-18T00:00:00.000Z".to_string()), 5, false);
    state.status = AppStatus::Ok;
    state.usage_comparison = Some(crate::usage::UsageComparison {
        primary_window_left_percent_delta: -12.0,
        secondary_window_left_percent_delta: 3.0,
    });

    let summary = build_usage_summary(
        &state,
        Local.with_ymd_and_hms(2026, 6, 17, 8, 0, 0).single().unwrap(),
    );

    assert!(summary.contains("Codex Quota: OK"));
    assert!(summary.contains("5h: 96% left"));
    assert!(summary.contains("Change: 5h -12%, Weekly +3%"));
    assert!(!summary.contains("person@example.com"));
    assert!(!summary.contains("user_123"));
    assert!(!summary.contains("acct_123"));
}

#[test]
fn maps_http_status_to_app_status() {
    assert_eq!(map_http_status_to_app_status(401, false), AppStatus::AuthRequired);
    assert_eq!(map_http_status_to_app_status(403, false), AppStatus::AuthRequired);
    assert_eq!(map_http_status_to_app_status(429, true), AppStatus::ApiError);
    assert_eq!(map_http_status_to_app_status(500, true), AppStatus::ApiError);
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvalProbe {
    has_user: bool,
    path: String,
}

#[test]
fn decodes_webview_eval_callback_result() {
    let direct: EvalProbe =
        decode_eval_result(r#"{"hasUser":true,"path":"/codex/cloud/settings/analytics"}"#)
            .unwrap();
    assert!(direct.has_user);
    assert_eq!(direct.path, "/codex/cloud/settings/analytics");

    let encoded: EvalProbe = decode_eval_result(
        r#""{\"hasUser\":true,\"path\":\"/codex/cloud/settings/analytics\"}""#,
    )
    .unwrap();
    assert!(encoded.has_user);
    assert_eq!(encoded.path, "/codex/cloud/settings/analytics");
}
