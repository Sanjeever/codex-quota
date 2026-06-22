import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import './styles.css';

const DEBUG_STATE_CHANGED = 'debug_state_changed';

type AppStatus =
  | 'OK'
  | 'Low quota'
  | 'Critical quota'
  | 'Auth required'
  | 'Request timeout'
  | 'Offline'
  | 'API error'
  | 'Parse error';

type UsageWindow = {
  usedPercent: number;
  leftPercent: number;
  limitWindowSeconds: number;
  resetAfterSeconds: number;
  resetAt: number;
  resetText: string;
};

type CodexUsage = {
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

type DebugState = {
  status: AppStatus;
  usage: CodexUsage | null;
  usageComparisonText: string | null;
  lastUpdatedText: string;
  lastError: { status: AppStatus; message: string } | null;
  stale: boolean;
  refreshIntervalMinutes: number;
  launchAtLogin: boolean;
  isRefreshing: boolean;
  redactedJson: string;
};

function emptyState(): DebugState {
  return {
    status: 'Auth required',
    usage: null,
    usageComparisonText: null,
    lastUpdatedText: 'Never',
    lastError: null,
    stale: false,
    refreshIntervalMinutes: 5,
    launchAtLogin: false,
    isRefreshing: false,
    redactedJson: '{}'
  };
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd>{value ?? 'Unknown'}</dd>
    </div>
  );
}

function WindowFields({ label, window }: { label: string; window: UsageWindow }) {
  return (
    <section className="panel">
      <h2>{label}</h2>
      <dl>
        <Field label="used_percent" value={`${window.usedPercent}%`} />
        <Field label="left_percent" value={`${window.leftPercent}%`} />
        <Field label="reset_at" value={`${window.resetAt} (${window.resetText})`} />
        <Field label="reset_after_seconds" value={window.resetAfterSeconds} />
        <Field label="limit_window_seconds" value={window.limitWindowSeconds} />
      </dl>
    </section>
  );
}

function UsageDetails({ usage }: { usage: CodexUsage | null }) {
  if (!usage) {
    return <div className="empty">No successful usage snapshot is available.</div>;
  }

  return (
    <>
      <section className="panel">
        <h2>Account</h2>
        <dl>
          <Field label="email" value={usage.email} />
          <Field label="user_id" value={usage.userId} />
          <Field label="account_id" value={usage.accountId} />
          <Field label="plan_type" value={usage.planType} />
        </dl>
      </section>

      <WindowFields label="Primary window" window={usage.rateLimit.primaryWindow} />
      <WindowFields label="Weekly window" window={usage.rateLimit.secondaryWindow} />

      <section className="panel">
        <h2>Credits and limits</h2>
        <dl>
          <Field label="credits.has_credits" value={String(usage.credits.hasCredits)} />
          <Field label="credits.unlimited" value={String(usage.credits.unlimited)} />
          <Field label="credits.balance" value={usage.credits.balance} />
          <Field label="allowed" value={String(usage.rateLimit.allowed)} />
          <Field label="limit_reached" value={String(usage.rateLimit.limitReached)} />
          <Field label="rate_limit_reached_type" value={usage.rateLimitReachedType} />
        </dl>
      </section>
    </>
  );
}

function App() {
  const [state, setState] = useState<DebugState>(emptyState);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void invoke<DebugState>('get_debug_state').then(setState);
    void listen<DebugState>(DEBUG_STATE_CHANGED, (event) => setState(event.payload)).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const statusClass = (() => {
    if (state.status === 'OK') return 'status-ok';
    if (state.status === 'Low quota') return 'status-low';
    if (state.status === 'Critical quota') return 'status-critical';
    return 'status-error';
  })();

  async function refreshNow() {
    const next = await invoke<DebugState>('refresh_now');
    setState(next);
  }

  async function copyJson() {
    await invoke('copy_json');
    setCopyState('copied');
    window.setTimeout(() => setCopyState('idle'), 1200);
  }

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">Local debug details</p>
          <h1>Codex Quota</h1>
        </div>
        <div className={`status ${statusClass}`}>{state.status}</div>
      </header>

      <div className="actions">
        <button type="button" onClick={() => void copyJson()}>
          {copyState === 'copied' ? 'Copied JSON' : 'Copy JSON'}
        </button>
        <button type="button" onClick={() => void refreshNow()} disabled={state.isRefreshing}>
          {state.isRefreshing ? 'Refreshing' : 'Refresh now'}
        </button>
      </div>

      <section className="panel">
        <h2>Runtime</h2>
        <dl>
          <Field label="status" value={state.status} />
          <Field label="last_updated" value={state.lastUpdatedText} />
          <Field label="showing_stale_data" value={String(state.stale)} />
          <Field label="refresh_interval_minutes" value={state.refreshIntervalMinutes} />
          <Field label="launch_at_login" value={String(state.launchAtLogin)} />
          <Field label="usage_change" value={state.usageComparisonText ?? 'None'} />
          <Field label="last_sanitized_error" value={state.lastError ? `${state.lastError.status}: ${state.lastError.message}` : 'None'} />
        </dl>
      </section>

      <UsageDetails usage={state.usage} />

      <section className="json-panel">
        <h2>Sanitized JSON</h2>
        <pre>{state.redactedJson}</pre>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
