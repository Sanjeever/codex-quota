export type AppStatus =
  | 'OK'
  | 'Low quota'
  | 'Critical quota'
  | 'Auth required'
  | 'Request timeout'
  | 'Offline'
  | 'API error'
  | 'Parse error';

export type UsageWindow = {
  usedPercent: number;
  leftPercent: number;
  limitWindowSeconds: number;
  resetAfterSeconds: number;
  resetAt: number;
};

export type CodexUsage = {
  userId?: string | null;
  accountId?: string | null;
  email?: string | null;
  planType?: string | null;
  rateLimit: {
    allowed: boolean;
    limitReached: boolean;
    primaryWindow: UsageWindow;
    secondaryWindow: UsageWindow;
  };
  credits: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: number | null;
  };
  rateLimitReachedType?: string | null;
};

export type SanitizedError = {
  status: AppStatus;
  message: string;
  httpStatus?: number;
  occurredAt: string;
};

export type DebugState = {
  status: AppStatus;
  usage: CodexUsage | null;
  lastUpdatedAt: string | null;
  lastError: SanitizedError | null;
  stale: boolean;
  refreshIntervalMinutes: number;
  launchAtLogin: boolean;
  isRefreshing: boolean;
};
