import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { classifyUsage, compareUsage, leftPercentFromUsed, mapHttpStatusToAppStatus, parseUsageResponse } from '../src/shared/usage';
import { formatCompactLastUpdated, formatPrimaryReset, formatRelativeReset, formatResetWithRelative, formatWeeklyReset } from '../src/shared/time';
import { toDebugJson } from '../src/shared/debug';
import { buildUsageSummary } from '../src/shared/summary';
import type { DebugState } from '../src/shared/types';

function response(overrides: Record<string, unknown> = {}) {
  return {
    user_id: 'user_123',
    account_id: 'acct_123',
    email: 'person@example.com',
    plan_type: 'pro',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 4,
        limit_window_seconds: 18_000,
        reset_after_seconds: 1_200,
        reset_at: 1_781_701_320
      },
      secondary_window: {
        used_percent: 64,
        limit_window_seconds: 604_800,
        reset_after_seconds: 86_400,
        reset_at: 1_781_737_320
      }
    },
    credits: {
      has_credits: true,
      unlimited: false,
      balance: 12
    },
    rate_limit_reached_type: null,
    extra_field: 'allowed',
    ...overrides
  };
}

describe('usage parser', () => {
  it('parses and maps the Codex usage response', () => {
    const usage = parseUsageResponse(response());

    expect(usage.email).toBe('person@example.com');
    expect(usage.userId).toBe('user_123');
    expect(usage.accountId).toBe('acct_123');
    expect(usage.planType).toBe('pro');
    expect(usage.rateLimit.primaryWindow.usedPercent).toBe(4);
    expect(usage.rateLimit.primaryWindow.leftPercent).toBe(96);
    expect(usage.rateLimit.secondaryWindow.leftPercent).toBe(36);
    expect(usage.credits.balance).toBe(12);
  });

  it('accepts numeric string credit balance from the web endpoint', () => {
    const usage = parseUsageResponse(
      response({
        credits: {
          has_credits: true,
          unlimited: false,
          balance: '12.5'
        }
      })
    );

    expect(usage.credits.balance).toBe(12.5);
  });

  it('rejects missing or invalid required fields', () => {
    expect(() =>
      parseUsageResponse(
        response({
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              limit_window_seconds: 18_000,
              reset_after_seconds: 1_200,
              reset_at: 1_781_701_320
            },
            secondary_window: {
              used_percent: 64,
              limit_window_seconds: 604_800,
              reset_after_seconds: 86_400,
              reset_at: 1_781_737_320
            }
          }
        })
      )
    ).toThrow(ZodError);

    expect(() =>
      parseUsageResponse(
        response({
          credits: {
            has_credits: true,
            unlimited: false,
            balance: 'not-a-number'
          }
        })
      )
    ).toThrow(ZodError);
  });
});

describe('quota calculations', () => {
  it('clamps remaining percent', () => {
    expect(leftPercentFromUsed(4)).toBe(96);
    expect(leftPercentFromUsed(100)).toBe(0);
    expect(leftPercentFromUsed(120)).toBe(0);
    expect(leftPercentFromUsed(-10)).toBe(100);
  });

  it('classifies status from usage', () => {
    expect(classifyUsage(parseUsageResponse(response()))).toBe('OK');
    expect(classifyUsage(parseUsageResponse(response({ rate_limit: { ...response().rate_limit, primary_window: { ...response().rate_limit.primary_window, used_percent: 80 } } })))).toBe('Low quota');
    expect(classifyUsage(parseUsageResponse(response({ rate_limit: { ...response().rate_limit, secondary_window: { ...response().rate_limit.secondary_window, used_percent: 95 } } })))).toBe('Critical quota');
    expect(classifyUsage(parseUsageResponse(response({ rate_limit: { ...response().rate_limit, limit_reached: true } })))).toBe('Critical quota');
  });

  it('compares current quota to the previous in-memory snapshot', () => {
    const previous = parseUsageResponse(response());
    const current = parseUsageResponse(
      response({
        rate_limit: {
          ...response().rate_limit,
          primary_window: { ...response().rate_limit.primary_window, used_percent: 20 },
          secondary_window: { ...response().rate_limit.secondary_window, used_percent: 60 }
        }
      })
    );

    expect(compareUsage(previous, current)).toEqual({
      primaryWindowLeftPercentDelta: -16,
      secondaryWindowLeftPercentDelta: 4
    });
  });
});

describe('time formatting', () => {
  it('formats primary reset as time when today', () => {
    const now = new Date(2026, 5, 17, 8, 0, 0);
    const resetAt = new Date(2026, 5, 17, 10, 22, 0).getTime() / 1000;

    expect(formatPrimaryReset(resetAt, now)).toBe('10:22');
  });

  it('formats primary reset with date when not today', () => {
    const now = new Date(2026, 5, 17, 8, 0, 0);
    const resetAt = new Date(2026, 5, 18, 10, 22, 0).getTime() / 1000;

    expect(formatPrimaryReset(resetAt, now)).toBe('Jun 18, 10:22');
  });

  it('always formats weekly reset with date and time', () => {
    const resetAt = new Date(2026, 5, 18, 10, 22, 0).getTime() / 1000;

    expect(formatWeeklyReset(resetAt)).toBe('Jun 18, 10:22');
  });

  it('formats reset time with relative and absolute text', () => {
    const now = new Date(2026, 5, 17, 8, 0, 0);
    const resetAt = new Date(2026, 5, 17, 10, 14, 0).getTime() / 1000;

    expect(formatRelativeReset(resetAt, now)).toBe('in 2h 14m');
    expect(formatResetWithRelative(resetAt, '10:14', now)).toBe('in 2h 14m at 10:14');
  });

  it('formats longer and passed relative reset times', () => {
    const now = new Date(2026, 5, 17, 8, 0, 0);
    const resetAt = new Date(2026, 5, 20, 12, 0, 0).getTime() / 1000;
    const passedAt = new Date(2026, 5, 17, 7, 59, 0).getTime() / 1000;

    expect(formatRelativeReset(resetAt, now)).toBe('in 3d 4h');
    expect(formatRelativeReset(passedAt, now)).toBe('passed');
  });

  it('formats compact last updated text for constrained tooltips', () => {
    const updatedAt = new Date(2026, 5, 18, 9, 13, 36).toISOString();

    expect(formatCompactLastUpdated(updatedAt)).toBe('Jun 18, 09:13');
  });
});

describe('debug output', () => {
  it('redacts account identifiers from copied debug JSON', () => {
    const state: DebugState = {
      status: 'OK',
      usage: parseUsageResponse(response()),
      usageComparison: null,
      lastUpdatedAt: '2026-06-18T00:00:00.000Z',
      lastError: null,
      stale: false,
      refreshIntervalMinutes: 5,
      launchAtLogin: false,
      isRefreshing: false
    };

    const debugJson = toDebugJson(state);

    expect(debugJson).toContain('p***@example.com');
    expect(debugJson).not.toContain('person@example.com');
    expect(debugJson).not.toContain('user_123');
    expect(debugJson).not.toContain('acct_123');
  });

  it('builds a copied summary without account identifiers', () => {
    const usage = parseUsageResponse(response());
    const state: DebugState = {
      status: 'OK',
      usage,
      usageComparison: {
        primaryWindowLeftPercentDelta: -12,
        secondaryWindowLeftPercentDelta: 3
      },
      lastUpdatedAt: '2026-06-18T00:00:00.000Z',
      lastError: null,
      stale: false,
      refreshIntervalMinutes: 5,
      launchAtLogin: false,
      isRefreshing: false
    };

    const summary = buildUsageSummary(state, new Date(2026, 5, 17, 8, 0, 0));

    expect(summary).toContain('Codex Quota: OK');
    expect(summary).toContain('5h: 96% left');
    expect(summary).toContain('Change: 5h -12%, Weekly +3%');
    expect(summary).not.toContain('person@example.com');
    expect(summary).not.toContain('user_123');
    expect(summary).not.toContain('acct_123');
  });
});

describe('http status mapping', () => {
  it('maps 401 and 403 to auth required', () => {
    expect(mapHttpStatusToAppStatus(401)).toBe('Auth required');
    expect(mapHttpStatusToAppStatus(403)).toBe('Auth required');
  });

  it('maps other non-2xx responses to api error', () => {
    expect(mapHttpStatusToAppStatus(429)).toBe('API error');
    expect(mapHttpStatusToAppStatus(500)).toBe('API error');
  });
});
