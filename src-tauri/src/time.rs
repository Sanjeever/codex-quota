use chrono::{DateTime, Datelike, Local, TimeZone, Timelike};

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

pub fn format_primary_reset(reset_at_unix_seconds: u64, now: DateTime<Local>) -> String {
    let reset = local_from_unix(reset_at_unix_seconds);
    if reset.year() == now.year() && reset.month() == now.month() && reset.day() == now.day() {
        return format_time(reset);
    }

    format_date_time(reset)
}

pub fn format_weekly_reset(reset_at_unix_seconds: u64) -> String {
    format_date_time(local_from_unix(reset_at_unix_seconds))
}

pub fn format_relative_reset(reset_at_unix_seconds: u64, now: DateTime<Local>) -> String {
    let reset = local_from_unix(reset_at_unix_seconds);
    let delta_ms = reset.timestamp_millis() - now.timestamp_millis();
    if delta_ms <= 0 {
        return "passed".to_string();
    }

    let total_minutes = ((delta_ms as f64) / 60_000.0).ceil() as i64;
    let days = total_minutes / 1_440;
    let hours = (total_minutes % 1_440) / 60;
    let minutes = total_minutes % 60;

    if days > 0 {
        if hours > 0 {
            return format!("in {days}d {hours}h");
        }
        return format!("in {days}d");
    }

    if hours > 0 {
        if minutes > 0 {
            return format!("in {hours}h {minutes}m");
        }
        return format!("in {hours}h");
    }

    format!("in {minutes}m")
}

pub fn format_reset_with_relative(
    reset_at_unix_seconds: u64,
    absolute_text: &str,
    now: DateTime<Local>,
) -> String {
    format!(
        "{} at {}",
        format_relative_reset(reset_at_unix_seconds, now),
        absolute_text
    )
}

pub fn format_last_updated(iso_string: Option<&str>) -> String {
    match iso_string.and_then(parse_iso_local) {
        Some(date) => format!(
            "{} {}, {:02}:{:02}:{:02}",
            month_name(date.month()),
            date.day(),
            date.hour(),
            date.minute(),
            date.second()
        ),
        None => "Never".to_string(),
    }
}

pub fn format_compact_last_updated(iso_string: Option<&str>) -> String {
    match iso_string.and_then(parse_iso_local) {
        Some(date) => format_date_time(date),
        None => "Never".to_string(),
    }
}

pub fn now_iso() -> String {
    Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn parse_iso_local(value: &str) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.with_timezone(&Local))
}

fn local_from_unix(seconds: u64) -> DateTime<Local> {
    Local
        .timestamp_opt(seconds as i64, 0)
        .single()
        .expect("valid unix timestamp")
}

fn format_time(date: DateTime<Local>) -> String {
    format!("{:02}:{:02}", date.hour(), date.minute())
}

fn format_date_time(date: DateTime<Local>) -> String {
    format!(
        "{} {}, {:02}:{:02}",
        month_name(date.month()),
        date.day(),
        date.hour(),
        date.minute()
    )
}

fn month_name(month: u32) -> &'static str {
    MONTHS[(month - 1) as usize]
}
