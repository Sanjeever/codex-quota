import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  session,
  shell,
  Tray
} from 'electron';
import Store from 'electron-store';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { classifyUsage, mapHttpStatusToAppStatus, parseUsageResponse } from '../shared/usage';
import { formatLastUpdated, formatPrimaryReset, formatWeeklyReset } from '../shared/time';
import { toDebugJson } from '../shared/debug';
import type { AppStatus, CodexUsage, DebugState, SanitizedError } from '../shared/types';

const APP_NAME = 'Codex Quota';
const CHATGPT_PARTITION = 'persist:codex-quota-chatgpt';
const ANALYTICS_URL = 'https://chatgpt.com/codex/cloud/settings/analytics';
const ANALYTICS_PATH = '/codex/cloud/settings/analytics';
const REFRESH_TIMEOUT_MS = 30_000;
const CHATGPT_APP_READY_DELAY_MS = 4_000;
const CHATGPT_SESSION_WAIT_MS = 20_000;
const DEFAULT_REFRESH_INTERVAL_MINUTES = 5;
const REFRESH_INTERVALS = [1, 5, 15, 30] as const;

type RefreshIntervalMinutes = (typeof REFRESH_INTERVALS)[number];

type StoreShape = {
  refreshIntervalMinutes: RefreshIntervalMinutes;
  launchAtLogin: boolean;
  lastKnownUsage: CodexUsage | null;
  lastUpdatedAt: string | null;
};

type RuntimeState = DebugState;

let tray: Tray | null = null;
let loginWindow: BrowserWindow | null = null;
let hiddenWindow: BrowserWindow | null = null;
let debugWindow: BrowserWindow | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let loginRefreshTimer: NodeJS.Timeout | null = null;
let pendingRefresh = false;
let autoCloseLoginWindowAfterRefresh = false;

const store = new Store<StoreShape>({
  name: 'codex-quota',
  defaults: {
    refreshIntervalMinutes: DEFAULT_REFRESH_INTERVAL_MINUTES,
    launchAtLogin: false,
    lastKnownUsage: null,
    lastUpdatedAt: null
  }
});

const initialUsage = store.get('lastKnownUsage');

let state: RuntimeState = {
  status: initialUsage ? classifyUsage(initialUsage) : 'Auth required',
  usage: initialUsage,
  lastUpdatedAt: store.get('lastUpdatedAt'),
  lastError: null,
  stale: false,
  refreshIntervalMinutes: store.get('refreshIntervalMinutes'),
  launchAtLogin: store.get('launchAtLogin'),
  isRefreshing: false
};

function assetPath(fileName: string): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'assets', fileName);
  }

  return join(process.cwd(), 'build', 'assets', fileName);
}

function appIconPath(): string {
  return assetPath(process.platform === 'win32' ? 'app.ico' : 'app.png');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isErrorStatus(status: AppStatus): boolean {
  return status === 'Auth required' || status === 'Request timeout' || status === 'Offline' || status === 'API error' || status === 'Parse error';
}

function trayImage() {
  const error = isErrorStatus(state.status);
  const icon = nativeImage.createFromPath(assetPath(error ? 'tray-error.png' : 'tray-normal.png'));
  if (process.platform === 'darwin' && !error) {
    icon.setTemplateImage(true);
  }
  return icon;
}

function shortTitle(): string {
  if (!state.usage) {
    return 'Codex ?';
  }

  const primary = Math.round(state.usage.rateLimit.primaryWindow.leftPercent);
  const weekly = Math.round(state.usage.rateLimit.secondaryWindow.leftPercent);
  return `Codex 5h ${primary}% | Weekly ${weekly}%`;
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function quotaLine(label: string, window: CodexUsage['rateLimit']['primaryWindow'], resetText: string): string {
  return `${label}: ${formatPercent(window.leftPercent)} left, ${formatPercent(window.usedPercent)} used, reset ${resetText}`;
}

function setState(next: Partial<RuntimeState>): void {
  state = { ...state, ...next };
  rebuildTray();
  sendDebugState();
}

function safeError(status: AppStatus, message: string, httpStatus?: number): SanitizedError {
  return {
    status,
    message,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    occurredAt: new Date().toISOString()
  };
}

function rebuildTray(): void {
  if (!tray) {
    return;
  }

  tray.setImage(trayImage());
  tray.setToolTip(`${shortTitle()} - ${state.status}`);

  if (process.platform === 'darwin') {
    tray.setTitle(shortTitle());
  }

  const usage = state.usage;
  const template: MenuItemConstructorOptions[] = [
    { label: APP_NAME, enabled: false },
    { label: `Status: ${state.status}${state.isRefreshing ? ' (refreshing)' : ''}`, enabled: false },
    ...(usage?.email ? [{ label: `Account: ${usage.email}`, enabled: false }] : []),
    ...(usage?.planType ? [{ label: `Plan: ${usage.planType}`, enabled: false }] : []),
    ...(usage
      ? [
          {
            label: quotaLine('5h quota', usage.rateLimit.primaryWindow, formatPrimaryReset(usage.rateLimit.primaryWindow.resetAt)),
            enabled: false
          },
          {
            label: quotaLine('Weekly quota', usage.rateLimit.secondaryWindow, formatWeeklyReset(usage.rateLimit.secondaryWindow.resetAt)),
            enabled: false
          },
          {
            label: `Credits: ${usage.credits.unlimited ? 'Unlimited' : (usage.credits.balance ?? 'Unknown')}`,
            enabled: false
          }
        ]
      : [{ label: 'Quota: Unknown', enabled: false }]),
    { label: `Last updated: ${formatLastUpdated(state.lastUpdatedAt)}`, enabled: false },
    ...(state.stale ? [{ label: 'Showing stale data', enabled: false }] : []),
    { type: 'separator' },
    { label: 'Refresh now', click: () => void refreshUsage('manual') },
    { label: 'Open analytics', click: () => openLoginWindow('user') },
    { label: 'Debug details', click: () => openDebugWindow() },
    { type: 'separator' },
    {
      label: 'Refresh interval',
      submenu: REFRESH_INTERVALS.map((minutes) => ({
        label: `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`,
        type: 'radio',
        checked: state.refreshIntervalMinutes === minutes,
        click: () => setRefreshInterval(minutes)
      }))
    },
    {
      label: 'Launch at login',
      type: 'checkbox',
      checked: state.launchAtLogin,
      click: (item) => setLaunchAtLogin(item.checked)
    },
    { label: 'Sign out / Reset ChatGPT session', click: () => void resetSession() },
    { label: `About ${APP_NAME}`, click: () => showAbout() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ];

  const menu = Menu.buildFromTemplate(template);

  tray.setContextMenu(menu);
}

function createTray(): void {
  tray = new Tray(trayImage());
  rebuildTray();
}

function setupRefreshTimer(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }

  refreshTimer = setInterval(
    () => {
      void refreshUsage('timer');
    },
    state.refreshIntervalMinutes * 60 * 1000
  );
}

function setRefreshInterval(minutes: RefreshIntervalMinutes): void {
  store.set('refreshIntervalMinutes', minutes);
  setState({ refreshIntervalMinutes: minutes });
  setupRefreshTimer();
}

function setLaunchAtLogin(openAtLogin: boolean): void {
  store.set('launchAtLogin', openAtLogin);
  app.setLoginItemSettings({ openAtLogin });
  setState({ launchAtLogin: openAtLogin });
}

function allowedAuthHost(hostname: string): boolean {
  return (
    hostname === 'chatgpt.com' ||
    hostname === 'chat.openai.com' ||
    hostname === 'openai.com' ||
    hostname.endsWith('.openai.com')
  );
}

function restrictNavigation(window: BrowserWindow, mode: 'auth' | 'local'): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (mode === 'local') {
      event.preventDefault();
      void shell.openExternal(url);
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      event.preventDefault();
      return;
    }

    if (parsed.protocol !== 'https:' || !allowedAuthHost(parsed.hostname)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
}

function openLoginWindow(reason: 'auth' | 'user' = 'auth'): void {
  autoCloseLoginWindowAfterRefresh = reason === 'auth';

  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.show();
    loginWindow.focus();
    return;
  }

  loginWindow = new BrowserWindow({
    width: 1160,
    height: 820,
    title: `${APP_NAME} - ChatGPT`,
    icon: appIconPath(),
    show: true,
    webPreferences: {
      partition: CHATGPT_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  restrictNavigation(loginWindow, 'auth');
  loginWindow.webContents.on('did-navigate', (_event, url) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }

    if (parsed.hostname !== 'chatgpt.com') {
      return;
    }

    if (loginRefreshTimer) {
      clearTimeout(loginRefreshTimer);
    }

    loginRefreshTimer = setTimeout(() => {
      void refreshUsage('manual');
    }, CHATGPT_APP_READY_DELAY_MS);
  });
  loginWindow.on('closed', () => {
    loginWindow = null;
  });
  void loginWindow.loadURL(ANALYTICS_URL);
}

function getHiddenWindow(): BrowserWindow {
  if (hiddenWindow && !hiddenWindow.isDestroyed()) {
    return hiddenWindow;
  }

  hiddenWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      partition: CHATGPT_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  restrictNavigation(hiddenWindow, 'auth');
  hiddenWindow.on('closed', () => {
    hiddenWindow = null;
  });
  return hiddenWindow;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('request_timeout')), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

type FetchResult =
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

function sanitizedUrlForDebug(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return 'Unknown';
  }
}

async function fetchUsageInSession(): Promise<FetchResult> {
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

async function getUsageFetchWindow(): Promise<BrowserWindow> {
  if (loginWindow && !loginWindow.isDestroyed()) {
    try {
      if (new URL(loginWindow.webContents.getURL()).hostname === 'chatgpt.com') {
        return loginWindow;
      }
    } catch {
      // Fall through to the hidden window.
    }
  }

  const window = getHiddenWindow();
  await session.fromPartition(CHATGPT_PARTITION).cookies.flushStore();
  await withTimeout(window.loadURL(ANALYTICS_URL), REFRESH_TIMEOUT_MS);
  await sleep(CHATGPT_APP_READY_DELAY_MS);
  return window;
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

function isNetworkFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('ERR_INTERNET_DISCONNECTED') || message.includes('ERR_NETWORK') || message.includes('ERR_NAME_NOT_RESOLVED');
}

async function refreshUsage(_source: 'startup' | 'timer' | 'manual'): Promise<void> {
  if (state.isRefreshing) {
    pendingRefresh = true;
    return;
  }

  pendingRefresh = false;
  setState({ isRefreshing: true });

  try {
    const result = await fetchUsageInSession();
    if (!result.ok) {
      const status = result.parseError ? 'Parse error' : mapHttpStatusToAppStatus(result.status);
      const messagePrefix =
        status === 'Auth required' && result.authenticatedSession
          ? 'Authenticated ChatGPT session, but usage endpoint returned unauthorized. '
          : '';
      const message = result.finalUrl
        ? `${messagePrefix}HTTP ${result.status} at ${result.finalUrl}: ${result.text}`
        : `${messagePrefix}${result.text}`;
      setState({
        status,
        lastError: safeError(status, message || `HTTP ${result.status}`, result.status),
        stale: Boolean(state.usage),
        isRefreshing: false
      });

      if (status === 'Auth required' && !result.authenticatedSession) {
        openLoginWindow();
      }
      runPendingRefresh();
      return;
    }

    const usage = parseUsageResponse(result.data);
    const lastUpdatedAt = new Date().toISOString();
    store.set('lastKnownUsage', usage);
    store.set('lastUpdatedAt', lastUpdatedAt);
    setState({
      status: classifyUsage(usage),
      usage,
      lastUpdatedAt,
      lastError: null,
      stale: false,
      isRefreshing: false
    });
    closeAutoLoginWindowAfterSuccessfulRefresh();
    runPendingRefresh();
  } catch (error) {
    const status: AppStatus =
      error instanceof ZodError || error instanceof SyntaxError
        ? 'Parse error'
        : error instanceof Error && error.message === 'request_timeout'
          ? 'Request timeout'
          : isNetworkFailure(error)
            ? 'Offline'
            : 'API error';

    setState({
      status,
      lastError: safeError(status, error instanceof Error ? error.message : String(error)),
      stale: Boolean(state.usage),
      isRefreshing: false
    });
    runPendingRefresh();
  }
}

function closeAutoLoginWindowAfterSuccessfulRefresh(): void {
  if (!autoCloseLoginWindowAfterRefresh || !loginWindow || loginWindow.isDestroyed()) {
    return;
  }

  autoCloseLoginWindowAfterRefresh = false;
  loginWindow.close();
}

function runPendingRefresh(): void {
  if (!pendingRefresh) {
    return;
  }

  pendingRefresh = false;
  setTimeout(() => {
    void refreshUsage('manual');
  }, 250);
}

function openDebugWindow(): void {
  if (debugWindow && !debugWindow.isDestroyed()) {
    debugWindow.show();
    debugWindow.focus();
    sendDebugState();
    return;
  }

  debugWindow = new BrowserWindow({
    width: 840,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    title: `${APP_NAME} - Debug details`,
    icon: appIconPath(),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  restrictNavigation(debugWindow, 'local');
  debugWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      debugWindow?.hide();
    }
  });
  debugWindow.on('closed', () => {
    debugWindow = null;
  });
  debugWindow.once('ready-to-show', () => {
    debugWindow?.show();
    sendDebugState();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void debugWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void debugWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function getDebugState(): DebugState {
  return state;
}

function sendDebugState(): void {
  if (debugWindow && !debugWindow.isDestroyed()) {
    debugWindow.webContents.send('debug:state-changed', getDebugState());
  }
}

async function resetSession(): Promise<void> {
  const chatSession = session.fromPartition(CHATGPT_PARTITION);
  await chatSession.clearStorageData();
  await chatSession.clearCache();
  store.set('lastKnownUsage', null);
  store.set('lastUpdatedAt', null);
  setState({
    status: 'Auth required',
    usage: null,
    lastUpdatedAt: null,
    lastError: safeError('Auth required', 'ChatGPT session was reset.'),
    stale: false
  });
  openLoginWindow('auth');
}

function showAbout(): void {
  void dialog.showMessageBox({
    type: 'info',
    title: `About ${APP_NAME}`,
    message: APP_NAME,
    detail:
      'Unofficial local tray app for viewing Codex quota from an authenticated ChatGPT web session.\n\nNo OpenAI or Codex official logos are used.',
    buttons: ['OK']
  });
}

ipcMain.handle('debug:get-state', () => getDebugState());
ipcMain.handle('debug:refresh-now', async () => {
  await refreshUsage('manual');
  return getDebugState();
});
ipcMain.handle('debug:copy-json', () => {
  clipboard.writeText(toDebugJson(getDebugState()));
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    openDebugWindow();
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
  });

  void app.whenReady().then(() => {
    app.setName(APP_NAME);
    app.setLoginItemSettings({ openAtLogin: state.launchAtLogin });
    createTray();
    setupRefreshTimer();
    void refreshUsage('startup');
  });

  app.on('window-all-closed', () => {});

  app.on('activate', () => {
    openDebugWindow();
  });
}
