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
  Tray
} from 'electron';
import Store from 'electron-store';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { classifyUsage, compareUsage, mapHttpStatusToAppStatus, parseUsageResponse } from '../shared/usage';
import { formatLastUpdated, formatPrimaryReset, formatResetWithRelative, formatWeeklyReset } from '../shared/time';
import { toDebugJson } from '../shared/debug';
import { buildUsageSummary, formatUsageComparison } from '../shared/summary';
import type { AppStatus, CodexUsage, DebugState, SanitizedError } from '../shared/types';
import { sleep, withTimeout } from './async';
import { fetchUsageInSession } from './chatgpt';
import {
  ANALYTICS_URL,
  APP_NAME,
  CHATGPT_APP_READY_DELAY_MS,
  CHATGPT_PARTITION,
  DEFAULT_REFRESH_INTERVAL_MINUTES,
  REFRESH_INTERVALS,
  REFRESH_TIMEOUT_MS,
  type RefreshIntervalMinutes
} from './constants';
import { restrictNavigation } from './navigation';

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
let isQuitting = false;

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
  usageComparison: null,
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

function primaryResetText(window: CodexUsage['rateLimit']['primaryWindow']): string {
  return formatResetWithRelative(window.resetAt, formatPrimaryReset(window.resetAt));
}

function weeklyResetText(window: CodexUsage['rateLimit']['secondaryWindow']): string {
  return formatResetWithRelative(window.resetAt, formatWeeklyReset(window.resetAt));
}

function staleLabel(): string {
  return state.lastUpdatedAt ? `Showing stale data from ${formatLastUpdated(state.lastUpdatedAt)}` : 'Showing stale data';
}

function statusLine(): string {
  return `Status: ${state.status}${state.stale ? ' (showing stale data)' : ''}${state.isRefreshing ? ' (refreshing)' : ''}`;
}

function tooltipText(): string {
  const lines = [APP_NAME, statusLine()];

  if (state.usage) {
    lines.push(
      `5h: ${formatPercent(state.usage.rateLimit.primaryWindow.leftPercent)} left, reset ${primaryResetText(state.usage.rateLimit.primaryWindow)}`,
      `Weekly: ${formatPercent(state.usage.rateLimit.secondaryWindow.leftPercent)} left, reset ${weeklyResetText(state.usage.rateLimit.secondaryWindow)}`
    );
  }

  if (state.stale) {
    lines.push(staleLabel());
  }

  lines.push(`Last updated: ${formatLastUpdated(state.lastUpdatedAt)}`);

  if (!state.usage && state.lastError) {
    lines.push(`Last error: ${state.lastError.status}`);
  }

  return lines.join('\n');
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
  tray.setToolTip(tooltipText());

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
            label: quotaLine('5h quota', usage.rateLimit.primaryWindow, primaryResetText(usage.rateLimit.primaryWindow)),
            enabled: false
          },
          {
            label: quotaLine('Weekly quota', usage.rateLimit.secondaryWindow, weeklyResetText(usage.rateLimit.secondaryWindow)),
            enabled: false
          },
          {
            label: `Credits: ${usage.credits.unlimited ? 'Unlimited' : (usage.credits.balance ?? 'Unknown')}`,
            enabled: false
          }
        ]
      : [{ label: 'Quota: Unknown', enabled: false }]),
    ...(usage && state.usageComparison && !state.stale ? [{ label: formatUsageComparison(state.usageComparison), enabled: false }] : []),
    { label: `Last updated: ${formatLastUpdated(state.lastUpdatedAt)}`, enabled: false },
    ...(state.stale ? [{ label: staleLabel(), enabled: false }] : []),
    { type: 'separator' },
    { label: 'Refresh now', click: () => void refreshUsage('manual') },
    { label: 'Copy summary', click: () => clipboard.writeText(buildUsageSummary(getDebugState())) },
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
    autoHideMenuBar: true,
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
    autoHideMenuBar: true,
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
    const result = await fetchUsageInSession(getUsageFetchWindow);
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
        usageComparison: null,
        isRefreshing: false
      });

      if (status === 'Auth required' && !result.authenticatedSession) {
        openLoginWindow();
      }
      runPendingRefresh();
      return;
    }

    const usage = parseUsageResponse(result.data);
    const usageComparison = state.usage ? compareUsage(state.usage, usage) : null;
    const lastUpdatedAt = new Date().toISOString();
    store.set('lastKnownUsage', usage);
    store.set('lastUpdatedAt', lastUpdatedAt);
    setState({
      status: classifyUsage(usage),
      usage,
      usageComparison,
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
      lastError: safeError(status, `${_source} refresh failed: ${error instanceof Error ? error.message : String(error)}`),
      stale: Boolean(state.usage),
      usageComparison: null,
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
    autoHideMenuBar: true,
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
    if (!isQuitting) {
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
    usageComparison: null,
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
    isQuitting = true;
  });

  void app.whenReady().then(() => {
    app.setName(APP_NAME);
    Menu.setApplicationMenu(null);
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
