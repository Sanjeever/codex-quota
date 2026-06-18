import type { BrowserWindow } from 'electron';
import { ANALYTICS_PATH, ANALYTICS_URL, CHATGPT_APP_READY_DELAY_MS, CHATGPT_SESSION_WAIT_MS, REFRESH_TIMEOUT_MS } from './constants';
import { sleep, withTimeout } from './async';

export type FetchResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; text: string; parseError?: boolean; finalUrl?: string; authenticatedSession?: boolean };

type AuthProbe = {
  sessionStatus: number | null;
  hasUser: boolean;
  hasAccessToken: boolean;
  pageReadyState: string;
  pageTitle: string;
  path: string;
};

export async function fetchUsageInSession(getUsageFetchWindow: () => Promise<BrowserWindow>): Promise<FetchResult> {
  const window = await getUsageFetchWindow();
  await ensureAnalyticsContext(window);

  const loadedUrl = window.webContents.getURL();
  const currentUrl = new URL(loadedUrl);
  if (currentUrl.hostname !== 'chatgpt.com') {
    return {
      ok: false,
      status: 401,
      text: `ChatGPT authentication required. Final page: ${sanitizedUrlForDebug(loadedUrl)}`,
      finalUrl: sanitizedUrlForDebug(loadedUrl)
    };
  }

  const probe = await waitForChatGptSession(window);
  if (!probe.hasUser) {
    return {
      ok: false,
      status: 401,
      text: `ChatGPT session was not available in Electron. Probe: ${formatAuthProbe(probe)}`,
      finalUrl: sanitizedUrlForDebug(loadedUrl),
      authenticatedSession: false
    };
  }

  return await executeUsageFetch(window);
}

function sanitizedUrlForDebug(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return 'Unknown';
  }
}

async function ensureAnalyticsContext(window: BrowserWindow): Promise<void> {
  const currentUrl = window.webContents.getURL();
  let parsed: URL;
  try {
    parsed = new URL(currentUrl);
  } catch {
    await withTimeout(window.loadURL(ANALYTICS_URL), REFRESH_TIMEOUT_MS);
    await sleep(CHATGPT_APP_READY_DELAY_MS);
    return;
  }

  if (parsed.hostname !== 'chatgpt.com' || parsed.pathname !== ANALYTICS_PATH) {
    await withTimeout(window.loadURL(ANALYTICS_URL), REFRESH_TIMEOUT_MS);
    await sleep(CHATGPT_APP_READY_DELAY_MS);
  }
}

async function executeUsageFetch(window: BrowserWindow): Promise<FetchResult> {
  const loadedUrl = window.webContents.getURL();
  const currentUrl = new URL(loadedUrl);
  if (currentUrl.hostname !== 'chatgpt.com') {
    return {
      ok: false,
      status: 401,
      text: `ChatGPT authentication required. Final page: ${sanitizedUrlForDebug(loadedUrl)}`,
      finalUrl: sanitizedUrlForDebug(loadedUrl)
    };
  }

  const script = `
    (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ${REFRESH_TIMEOUT_MS});
      try {
        const readAuthSession = async () => {
          try {
            const sessionResponse = await window.fetch('/api/auth/session', {
              method: 'GET',
              credentials: 'include',
              headers: { Accept: 'application/json' },
              signal: controller.signal
            });
            const sessionText = await sessionResponse.text();
            let sessionJson = null;
            try {
              sessionJson = JSON.parse(sessionText);
            } catch {
              sessionJson = null;
            }
            const accessToken =
              sessionJson && typeof sessionJson.accessToken === 'string' && sessionJson.accessToken.length > 0
                ? sessionJson.accessToken
                : null;
            return {
              accessToken,
              probe: {
                sessionStatus: sessionResponse.status,
                hasUser: Boolean(sessionJson && sessionJson.user),
                hasAccessToken: Boolean(accessToken),
                pageReadyState: document.readyState,
                pageTitle: document.title,
                path: location.pathname
              }
            };
          } catch {
            return {
              accessToken: null,
              probe: {
                sessionStatus: null,
                hasUser: false,
                hasAccessToken: false,
                pageReadyState: document.readyState,
                pageTitle: document.title,
                path: location.pathname
              }
            };
          }
        };

        const auth = await readAuthSession();
        const response = await window.fetch('/backend-api/wham/usage', {
          method: 'GET',
          credentials: 'include',
          headers: {
            Accept: 'application/json',
            ...(auth.accessToken ? { Authorization: 'Bearer ' + auth.accessToken } : {})
          },
          signal: controller.signal
        });
        const text = await response.text();
        if (!response.ok) {
          return {
            ok: false,
            status: response.status,
            text: text.slice(0, 500) + ' Probe: ' + JSON.stringify(auth.probe),
            finalUrl: location.origin + location.pathname,
            authenticatedSession: Boolean(auth.probe.hasUser)
          };
        }
        try {
          return { ok: true, status: response.status, data: JSON.parse(text) };
        } catch {
          return {
            ok: false,
            status: response.status,
            text: 'Invalid JSON response.',
            parseError: true,
            finalUrl: location.origin + location.pathname
          };
        }
      } finally {
        clearTimeout(timer);
      }
    })();
  `;

  return await withTimeout(window.webContents.executeJavaScript(script, true), REFRESH_TIMEOUT_MS);
}

async function probeChatGptAuth(window: BrowserWindow): Promise<AuthProbe> {
  const script = `
    (async () => {
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
    })();
  `;

  return await window.webContents.executeJavaScript(script, true);
}

async function waitForChatGptSession(window: BrowserWindow): Promise<AuthProbe> {
  const startedAt = Date.now();
  let lastProbe = await probeChatGptAuth(window);

  while (!lastProbe.hasUser && Date.now() - startedAt < CHATGPT_SESSION_WAIT_MS) {
    await sleep(1_000);
    lastProbe = await probeChatGptAuth(window);
  }

  return lastProbe;
}

function formatAuthProbe(probe: AuthProbe): string {
  return JSON.stringify({
    session_status: probe.sessionStatus,
    has_user: probe.hasUser,
    has_access_token: probe.hasAccessToken,
    page_ready_state: probe.pageReadyState,
    page_title: probe.pageTitle,
    path: probe.path
  });
}
