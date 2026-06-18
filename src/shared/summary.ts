import { formatLastUpdated, formatPrimaryReset, formatResetWithRelative, formatWeeklyReset } from './time';
import type { DebugState, UsageComparison } from './types';

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function formatDelta(value: number): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

export function formatUsageComparison(comparison: UsageComparison): string {
  return `Change: 5h ${formatDelta(comparison.primaryWindowLeftPercentDelta)}, Weekly ${formatDelta(comparison.secondaryWindowLeftPercentDelta)}`;
}

export function buildUsageSummary(state: DebugState, now = new Date()): string {
  const lines = [`Codex Quota: ${state.status}${state.stale ? ' (showing stale data)' : ''}`];

  if (state.usage) {
    const primary = state.usage.rateLimit.primaryWindow;
    const weekly = state.usage.rateLimit.secondaryWindow;
    lines.push(
      `5h: ${formatPercent(primary.leftPercent)} left, reset ${formatResetWithRelative(primary.resetAt, formatPrimaryReset(primary.resetAt, now), now)}`,
      `Weekly: ${formatPercent(weekly.leftPercent)} left, reset ${formatResetWithRelative(weekly.resetAt, formatWeeklyReset(weekly.resetAt), now)}`
    );

    if (state.usageComparison) {
      lines.push(formatUsageComparison(state.usageComparison));
    }
  } else if (state.lastError) {
    lines.push(`Last error: ${state.lastError.status}: ${state.lastError.message}`);
  }

  lines.push(`Last updated: ${formatLastUpdated(state.lastUpdatedAt)}`);
  return lines.join('\n');
}
