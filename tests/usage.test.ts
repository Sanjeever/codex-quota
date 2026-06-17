import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { classifyUsage, leftPercentFromUsed, mapHttpStatusToAppStatus, parseUsageResponse } from '../src/shared/usage';
import { formatPrimaryReset, formatWeeklyReset } from '../src/shared/time';

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
