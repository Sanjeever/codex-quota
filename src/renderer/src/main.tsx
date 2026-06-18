import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { toDebugJson } from '../../shared/debug';
import { formatUsageComparison } from '../../shared/summary';
import { formatLastUpdated, formatPrimaryReset, formatWeeklyReset } from '../../shared/time';
import type { CodexUsage, DebugState, UsageWindow } from '../../shared/types';
import './styles.css';

function emptyState(): DebugState {
  return {
    status: 'Auth required',
    usage: null,
    usageComparison: null,
    lastUpdatedAt: null,
    lastError: null,
    stale: false,
    refreshIntervalMinutes: 5,
    launchAtLogin: false,
    isRefreshing: false
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
  const resetText = label === 'Primary window' ? formatPrimaryReset(window.resetAt) : formatWeeklyReset(window.resetAt);

  return (
    <section className="panel">
      <h2>{label}</h2>
      <dl>
        <Field label="used_percent" value={`${window.usedPercent}%`} />
        <Field label="left_percent" value={`${window.leftPercent}%`} />
        <Field label="reset_at" value={`${window.resetAt} (${resetText})`} />
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
  const api = window.codexQuota;

  useEffect(() => {
    if (!api) {
      return undefined;
    }

    void api.getDebugState().then(setState);
    return api.onStateChanged(setState);
  }, [api]);

  const statusClass = useMemo(() => {
    if (state.status === 'OK') return 'status-ok';
    if (state.status === 'Low quota') return 'status-low';
    if (state.status === 'Critical quota') return 'status-critical';
    return 'status-error';
  }, [state.status]);

  async function refreshNow() {
    if (!api) return;
    const next = await api.refreshNow();
    setState(next);
  }

  async function copyJson() {
    if (!api) return;
    await api.copyJson();
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
        <button type="button" onClick={() => void refreshNow()} disabled={state.isRefreshing || !api}>
          {state.isRefreshing ? 'Refreshing' : 'Refresh now'}
        </button>
      </div>

      {!api ? (
        <section className="panel error-panel">
          <h2>Debug IPC unavailable</h2>
          <p>The preload script did not expose the local debug API. Restart the app after rebuilding the main process.</p>
        </section>
      ) : null}

      <section className="panel">
        <h2>Runtime</h2>
        <dl>
          <Field label="status" value={state.status} />
          <Field label="last_updated" value={formatLastUpdated(state.lastUpdatedAt)} />
          <Field label="showing_stale_data" value={String(state.stale)} />
          <Field label="refresh_interval_minutes" value={state.refreshIntervalMinutes} />
          <Field label="launch_at_login" value={String(state.launchAtLogin)} />
          <Field label="usage_change" value={state.usageComparison ? formatUsageComparison(state.usageComparison) : 'None'} />
          <Field label="last_sanitized_error" value={state.lastError ? `${state.lastError.status}: ${state.lastError.message}` : 'None'} />
        </dl>
      </section>

      <UsageDetails usage={state.usage} />

      <section className="json-panel">
        <h2>Sanitized JSON</h2>
        <pre>{toDebugJson(state)}</pre>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
