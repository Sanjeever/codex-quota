import type { CodexQuotaApi } from '../../preload';

declare global {
  interface Window {
    codexQuota: CodexQuotaApi;
  }
}

export {};
