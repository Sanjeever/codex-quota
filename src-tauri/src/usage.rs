use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AppStatus {
    #[serde(rename = "OK")]
    Ok,
    #[serde(rename = "Low quota")]
    LowQuota,
    #[serde(rename = "Critical quota")]
    CriticalQuota,
    #[serde(rename = "Auth required")]
    AuthRequired,
    #[serde(rename = "Request timeout")]
    RequestTimeout,
    #[serde(rename = "Offline")]
    Offline,
    #[serde(rename = "API error")]
    ApiError,
    #[serde(rename = "Parse error")]
    ParseError,
}

impl AppStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Ok => "OK",
            Self::LowQuota => "Low quota",
            Self::CriticalQuota => "Critical quota",
            Self::AuthRequired => "Auth required",
            Self::RequestTimeout => "Request timeout",
            Self::Offline => "Offline",
            Self::ApiError => "API error",
            Self::ParseError => "Parse error",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub used_percent: f64,
    pub left_percent: f64,
    pub limit_window_seconds: u64,
    pub reset_after_seconds: u64,
    pub reset_at: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsage {
    pub user_id: Option<String>,
    pub account_id: Option<String>,
    pub email: Option<String>,
    pub plan_type: Option<String>,
    pub rate_limit: RateLimit,
    pub credits: Credits,
    pub rate_limit_reached_type: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimit {
    pub allowed: bool,
    pub limit_reached: bool,
    pub primary_window: UsageWindow,
    pub secondary_window: UsageWindow,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credits {
    pub has_credits: bool,
    pub unlimited: bool,
    pub balance: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageComparison {
    pub primary_window_left_percent_delta: f64,
    pub secondary_window_left_percent_delta: f64,
}

#[derive(Deserialize)]
struct RawUsageResponse {
    #[serde(default)]
    user_id: Option<String>,
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    plan_type: Option<String>,
    rate_limit: RawRateLimit,
    credits: RawCredits,
    #[serde(default)]
    rate_limit_reached_type: Option<String>,
}

#[derive(Deserialize)]
struct RawRateLimit {
    allowed: bool,
    limit_reached: bool,
    primary_window: RawUsageWindow,
    secondary_window: RawUsageWindow,
}

#[derive(Deserialize)]
struct RawUsageWindow {
    #[serde(deserialize_with = "deserialize_percent")]
    used_percent: f64,
    limit_window_seconds: u64,
    reset_after_seconds: u64,
    reset_at: u64,
}

#[derive(Deserialize)]
struct RawCredits {
    has_credits: bool,
    unlimited: bool,
    #[serde(deserialize_with = "deserialize_balance")]
    balance: Option<f64>,
}

pub fn left_percent_from_used(used_percent: f64) -> f64 {
    clamp(100.0 - used_percent, 0.0, 100.0)
}

pub fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.min(max).max(min)
}

pub fn parse_usage_response(input: Value) -> Result<CodexUsage, String> {
    let raw: RawUsageResponse = serde_json::from_value(input).map_err(|error| error.to_string())?;
    Ok(map_usage_response(raw))
}

fn map_usage_response(response: RawUsageResponse) -> CodexUsage {
    CodexUsage {
        user_id: response.user_id,
        account_id: response.account_id,
        email: response.email,
        plan_type: response.plan_type,
        rate_limit: RateLimit {
            allowed: response.rate_limit.allowed,
            limit_reached: response.rate_limit.limit_reached,
            primary_window: map_window(response.rate_limit.primary_window),
            secondary_window: map_window(response.rate_limit.secondary_window),
        },
        credits: Credits {
            has_credits: response.credits.has_credits,
            unlimited: response.credits.unlimited,
            balance: response.credits.balance,
        },
        rate_limit_reached_type: response.rate_limit_reached_type,
    }
}

fn map_window(window: RawUsageWindow) -> UsageWindow {
    UsageWindow {
        used_percent: window.used_percent,
        left_percent: left_percent_from_used(window.used_percent),
        limit_window_seconds: window.limit_window_seconds,
        reset_after_seconds: window.reset_after_seconds,
        reset_at: window.reset_at,
    }
}

pub fn classify_usage(usage: &CodexUsage) -> AppStatus {
    let primary_left = usage.rate_limit.primary_window.left_percent;
    let secondary_left = usage.rate_limit.secondary_window.left_percent;

    if usage.rate_limit.limit_reached || primary_left < 10.0 || secondary_left < 10.0 {
        return AppStatus::CriticalQuota;
    }

    if primary_left < 30.0 || secondary_left < 30.0 {
        return AppStatus::LowQuota;
    }

    AppStatus::Ok
}

pub fn compare_usage(previous: &CodexUsage, current: &CodexUsage) -> UsageComparison {
    UsageComparison {
        primary_window_left_percent_delta: current.rate_limit.primary_window.left_percent
            - previous.rate_limit.primary_window.left_percent,
        secondary_window_left_percent_delta: current.rate_limit.secondary_window.left_percent
            - previous.rate_limit.secondary_window.left_percent,
    }
}

pub fn map_http_status_to_app_status(status: u16, authenticated_session: bool) -> AppStatus {
    if status == 401 || status == 403 {
        return AppStatus::AuthRequired;
    }

    if !authenticated_session && status == 0 {
        return AppStatus::AuthRequired;
    }

    AppStatus::ApiError
}

fn deserialize_percent<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = f64::deserialize(deserializer)?;
    if value.is_finite() && (0.0..=100.0).contains(&value) {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("percent must be finite and between 0 and 100"))
    }
}

fn deserialize_balance<'de, D>(deserializer: D) -> Result<Option<f64>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => number
            .as_f64()
            .filter(|value| value.is_finite())
            .map(Some)
            .ok_or_else(|| serde::de::Error::custom("balance must be finite")),
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            trimmed
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite())
                .map(Some)
                .ok_or_else(|| serde::de::Error::custom("balance string must be finite numeric"))
        }
        _ => Err(serde::de::Error::custom("balance must be number, string, or null")),
    }
}
