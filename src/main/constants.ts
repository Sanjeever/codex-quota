export const APP_NAME = 'Codex Quota';
export const CHATGPT_PARTITION = 'persist:codex-quota-chatgpt';
export const ANALYTICS_URL = 'https://chatgpt.com/codex/cloud/settings/analytics';
export const ANALYTICS_PATH = '/codex/cloud/settings/analytics';
export const REFRESH_TIMEOUT_MS = 30_000;
export const CHATGPT_APP_READY_DELAY_MS = 4_000;
export const CHATGPT_SESSION_WAIT_MS = 20_000;
export const DEFAULT_REFRESH_INTERVAL_MINUTES = 5;
export const REFRESH_INTERVALS = [1, 5, 15, 30] as const;

export type RefreshIntervalMinutes = (typeof REFRESH_INTERVALS)[number];
