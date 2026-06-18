use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, Url, WebviewWindow};
use tokio::sync::oneshot;

use crate::{
    app_state::{
        ANALYTICS_PATH, ANALYTICS_URL, CHATGPT_APP_READY_DELAY_MS, CHATGPT_SESSION_WAIT_MS,
        REFRESH_TIMEOUT_MS,
    },
    windows,
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FetchResult {
    pub ok: bool,
    pub status: u16,
    pub data: Option<Value>,
    pub text: Option<String>,
    pub parse_error: Option<bool>,
    pub final_url: Option<String>,
    pub authenticated_session: Option<bool>,
}

impl Default for FetchResult {
    fn default() -> Self {
        Self {
            ok: false,
            status: 0,
            data: None,
            text: Some("WebView script evaluation returned no data. The page may not have loaded.".into()),
            parse_error: Some(true),
            final_url: None,
            authenticated_session: Some(false),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AuthProbe {
    session_status: Option<u16>,
    has_user: bool,
    has_access_token: bool,
    page_ready_state: String,
    page_title: String,
    path: String,
}

impl Default for AuthProbe {
    fn default() -> Self {
        Self {
            session_status: None,
            has_user: false,
            has_access_token: false,
            page_ready_state: String::new(),
            page_title: String::new(),
            path: String::new(),
        }
    }
}

pub async fn fetch_usage_in_session(app: &AppHandle) -> Result<FetchResult, String> {
    let window = get_usage_fetch_window(app).await?;
    ensure_analytics_context(&window).await?;

    let loaded_url = window.url().map_err(|error| error.to_string())?;
    if loaded_url.host_str() != Some("chatgpt.com") {
        return Ok(FetchResult {
            ok: false,
            status: 401,
            data: None,
            text: Some(format!(
                "ChatGPT authentication required. Final page: {}",
                sanitized_url_for_debug(loaded_url.as_str())
            )),
            parse_error: None,
            final_url: Some(sanitized_url_for_debug(loaded_url.as_str())),
            authenticated_session: Some(false),
        });
    }

    let probe = wait_for_chatgpt_session(&window).await;
    if !probe.has_user {
        return Ok(FetchResult {
            ok: false,
            status: 401,
            data: None,
            text: Some(format!(
                "ChatGPT session was not available in Tauri. Probe: {}",
                format_auth_probe(&probe)
            )),
            parse_error: None,
            final_url: Some(sanitized_url_for_debug(loaded_url.as_str())),
            authenticated_session: Some(false),
        });
    }

    execute_usage_fetch(&window).await
}

async fn get_usage_fetch_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(windows::AUTH_LABEL) {
        if window
            .url()
            .ok()
            .and_then(|url| url.host_str().map(ToOwned::to_owned))
            .as_deref()
            == Some("chatgpt.com")
        {
            return Ok(window);
        }
    }

    let window = windows::get_hidden_window(app)?;
    navigate_to_analytics(&window).await?;
    Ok(window)
}

async fn ensure_analytics_context(window: &WebviewWindow) -> Result<(), String> {
    let current = window.url().ok();
    match current {
        Some(url) if url.host_str() == Some("chatgpt.com") && url.path() == ANALYTICS_PATH => Ok(()),
        _ => navigate_to_analytics(window).await,
    }
}

async fn navigate_to_analytics(window: &WebviewWindow) -> Result<(), String> {
    let url = Url::parse(ANALYTICS_URL).map_err(|error| error.to_string())?;
    with_timeout(async {
        window.navigate(url).map_err(|error| error.to_string())?;
        tokio::time::sleep(std::time::Duration::from_millis(CHATGPT_APP_READY_DELAY_MS)).await;
        Ok(())
    })
    .await
}

async fn execute_usage_fetch(window: &WebviewWindow) -> Result<FetchResult, String> {
    let loaded_url = window.url().map_err(|error| error.to_string())?;
    if loaded_url.host_str() != Some("chatgpt.com") {
        return Ok(FetchResult {
            ok: false,
            status: 401,
            data: None,
            text: Some(format!(
                "ChatGPT authentication required. Final page: {}",
                sanitized_url_for_debug(loaded_url.as_str())
            )),
            parse_error: None,
            final_url: Some(sanitized_url_for_debug(loaded_url.as_str())),
            authenticated_session: Some(false),
        });
    }

    let script = format!(
        r#"
        async () => {{
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), {REFRESH_TIMEOUT_MS});
          try {{
            const readAuthSession = async () => {{
              try {{
                const sessionResponse = await window.fetch('/api/auth/session', {{
                  method: 'GET',
                  credentials: 'include',
                  headers: {{ Accept: 'application/json' }},
                  signal: controller.signal
                }});
                const sessionText = await sessionResponse.text();
                let sessionJson = null;
                try {{
                  sessionJson = JSON.parse(sessionText);
                }} catch {{
                  sessionJson = null;
                }}
                const accessToken =
                  sessionJson && typeof sessionJson.accessToken === 'string' && sessionJson.accessToken.length > 0
                    ? sessionJson.accessToken
                    : null;
                return {{
                  accessToken,
                  probe: {{
                    sessionStatus: sessionResponse.status,
                    hasUser: Boolean(sessionJson && sessionJson.user),
                    hasAccessToken: Boolean(accessToken),
                    pageReadyState: document.readyState,
                    pageTitle: document.title,
                    path: location.pathname
                  }}
                }};
              }} catch {{
                return {{
                  accessToken: null,
                  probe: {{
                    sessionStatus: null,
                    hasUser: false,
                    hasAccessToken: false,
                    pageReadyState: document.readyState,
                    pageTitle: document.title,
                    path: location.pathname
                  }}
                }};
              }}
            }};

            const auth = await readAuthSession();
            const response = await window.fetch('/backend-api/wham/usage', {{
              method: 'GET',
              credentials: 'include',
              headers: {{
                Accept: 'application/json',
                ...(auth.accessToken ? {{ Authorization: 'Bearer ' + auth.accessToken }} : {{}})
              }},
              signal: controller.signal
            }});
            const text = await response.text();
            if (!response.ok) {{
              return {{
                ok: false,
                status: response.status,
                text: text.slice(0, 500) + ' Probe: ' + JSON.stringify(auth.probe),
                finalUrl: location.origin + location.pathname,
                authenticatedSession: Boolean(auth.probe.hasUser)
              }};
            }}
            try {{
              return {{ ok: true, status: response.status, data: JSON.parse(text) }};
            }} catch {{
              return {{
                ok: false,
                status: response.status,
                text: 'Invalid JSON response.',
                parseError: true,
                finalUrl: location.origin + location.pathname,
                authenticatedSession: Boolean(auth.probe.hasUser)
              }};
            }}
          }} catch (error) {{
            return {{
              ok: false,
              status: 0,
              text: error && error.name === 'AbortError' ? 'request_timeout' : String(error),
              finalUrl: location.origin + location.pathname,
              authenticatedSession: false
            }};
          }} finally {{
            clearTimeout(timer);
          }}
        }}
        "#
    );

    eval_async_json::<FetchResult>(window, script).await
}

async fn probe_chatgpt_auth(window: &WebviewWindow) -> AuthProbe {
    let script = r#"
      async () => {
        try {
          const response = await window.fetch('/api/auth/session', {
            method: 'GET',
            credentials: 'include',
            headers: { Accept: 'application/json' }
          });
          const text = await response.text();
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          return {
            sessionStatus: response.status,
            hasUser: Boolean(json && json.user),
            hasAccessToken: Boolean(json && typeof json.accessToken === 'string' && json.accessToken.length > 0),
            pageReadyState: document.readyState,
            pageTitle: document.title,
            path: location.pathname
          };
        } catch {
          return {
            sessionStatus: null,
            hasUser: false,
            hasAccessToken: false,
            pageReadyState: document.readyState,
            pageTitle: document.title,
            path: location.pathname
          };
        }
      }
    "#;

    eval_async_json::<AuthProbe>(window, script.to_string())
        .await
        .unwrap_or_default()
}

async fn wait_for_chatgpt_session(window: &WebviewWindow) -> AuthProbe {
    let started_at = std::time::Instant::now();
    let mut last_probe = probe_chatgpt_auth(window).await;

    while !last_probe.has_user && started_at.elapsed().as_millis() < CHATGPT_SESSION_WAIT_MS as u128 {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        last_probe = probe_chatgpt_auth(window).await;
    }

    last_probe
}

async fn eval_json<T>(window: &WebviewWindow, script: String) -> Result<T, String>
where
    T: for<'de> Deserialize<'de> + Send + 'static,
{
    let (sender, receiver) = oneshot::channel::<String>();
    let sender = std::sync::Mutex::new(Some(sender));
    window
        .eval_with_callback(script, move |value| {
            if let Ok(mut sender) = sender.lock() {
                if let Some(sender) = sender.take() {
                    let _ = sender.send(value);
                }
            }
        })
        .map_err(|error| error.to_string())?;

    let text = with_timeout(async {
        receiver.await.map_err(|error| error.to_string())
    })
    .await?;

    decode_eval_result(&text)
}

async fn eval_async_json<T>(window: &WebviewWindow, async_function: String) -> Result<T, String>
where
    T: for<'de> Deserialize<'de> + Send + 'static,
{
    let key = format!(
        "__codexQuotaEval{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos()
    );
    let key_json = serde_json::to_string(&key).map_err(|error| error.to_string())?;
    let start_script = format!(
        r#"
        (() => {{
          const key = {key_json};
          window[key] = {{ done: false, value: null, error: null }};
          ({async_function})()
            .then((value) => {{
              window[key] = {{ done: true, value, error: null }};
            }})
            .catch((error) => {{
              window[key] = {{
                done: true,
                value: null,
                error: error && error.name === 'AbortError' ? 'request_timeout' : String(error)
              }};
            }});
          return {{ started: true }};
        }})();
        "#
    );
    let _: Value = eval_json(window, start_script).await?;

    let started_at = std::time::Instant::now();
    while started_at.elapsed().as_millis() < REFRESH_TIMEOUT_MS as u128 {
        let poll_script = format!(
            r#"
            (() => {{
              const key = {key_json};
              const state = window[key] || {{ done: false, value: null, error: null }};
              if (state.done) {{
                delete window[key];
              }}
              return state;
            }})();
            "#
        );
        let envelope: EvalEnvelope<T> = eval_json(window, poll_script).await?;
        if envelope.done {
            if let Some(error) = envelope.error {
                return Err(error);
            }
            return envelope
                .value
                .ok_or_else(|| "WebView script evaluation returned no data.".to_string());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    Err("request_timeout".to_string())
}

#[derive(Deserialize)]
struct EvalEnvelope<T> {
    done: bool,
    value: Option<T>,
    error: Option<String>,
}

pub(crate) fn decode_eval_result<T>(text: &str) -> Result<T, String>
where
    T: for<'de> Deserialize<'de>,
{
    let value: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
    let value = match value {
        Value::String(inner) => serde_json::from_str(&inner).map_err(|error| error.to_string())?,
        other => other,
    };
    serde_json::from_value(value).map_err(|error| error.to_string())
}

async fn with_timeout<F, T>(future: F) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    tokio::time::timeout(
        std::time::Duration::from_millis(REFRESH_TIMEOUT_MS),
        future,
    )
    .await
    .map_err(|_| "request_timeout".to_string())?
}

pub fn sanitized_url_for_debug(url: &str) -> String {
    Url::parse(url)
        .map(|parsed| format!("{}{}", parsed.origin().ascii_serialization(), parsed.path()))
        .unwrap_or_else(|_| "Unknown".to_string())
}

fn format_auth_probe(probe: &AuthProbe) -> String {
    serde_json::json!({
        "session_status": probe.session_status,
        "has_user": probe.has_user,
        "has_access_token": probe.has_access_token,
        "page_ready_state": probe.page_ready_state,
        "page_title": probe.page_title,
        "path": probe.path
    })
    .to_string()
}
