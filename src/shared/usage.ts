import { z } from 'zod';
import type { AppStatus, CodexUsage, UsageComparison } from './types';

const percentSchema = z.number().finite().min(0).max(100);
const unixSecondsSchema = z.number().finite().int().nonnegative();
const balanceSchema = z.union([
  z.number().finite(),
  z
    .string()
    .trim()
    .regex(/^-?\d+(\.\d+)?$/),
  z.null()
]);

const usageWindowSchema = z
  .object({
    used_percent: percentSchema,
    limit_window_seconds: z.number().finite().int().positive(),
    reset_after_seconds: z.number().finite().int().nonnegative(),
    reset_at: unixSecondsSchema
  })
  .passthrough();

export const codexUsageResponseSchema = z
  .object({
    user_id: z.string().nullable().optional(),
    account_id: z.string().nullable().optional(),
    email: z.string().email().nullable().optional(),
    plan_type: z.string().nullable().optional(),
    rate_limit: z
      .object({
        allowed: z.boolean(),
        limit_reached: z.boolean(),
        primary_window: usageWindowSchema,
        secondary_window: usageWindowSchema
      })
      .passthrough(),
    credits: z
      .object({
        has_credits: z.boolean(),
        unlimited: z.boolean(),
        balance: balanceSchema
      })
      .passthrough(),
    rate_limit_reached_type: z.string().nullable().optional()
  })
  .passthrough();

export type CodexUsageResponse = z.infer<typeof codexUsageResponseSchema>;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function leftPercentFromUsed(usedPercent: number): number {
  return clamp(100 - usedPercent, 0, 100);
}

function mapWindow(window: CodexUsageResponse['rate_limit']['primary_window']) {
  return {
    usedPercent: window.used_percent,
    leftPercent: leftPercentFromUsed(window.used_percent),
    limitWindowSeconds: window.limit_window_seconds,
    resetAfterSeconds: window.reset_after_seconds,
    resetAt: window.reset_at
  };
}

function mapBalance(balance: CodexUsageResponse['credits']['balance']): number | null {
  if (balance === null) {
    return null;
  }

  if (typeof balance === 'number') {
    return balance;
  }

  return Number(balance);
}

export function mapUsageResponse(response: CodexUsageResponse): CodexUsage {
  return {
    userId: response.user_id ?? null,
    accountId: response.account_id ?? null,
    email: response.email ?? null,
    planType: response.plan_type ?? null,
    rateLimit: {
      allowed: response.rate_limit.allowed,
      limitReached: response.rate_limit.limit_reached,
      primaryWindow: mapWindow(response.rate_limit.primary_window),
      secondaryWindow: mapWindow(response.rate_limit.secondary_window)
    },
    credits: {
      hasCredits: response.credits.has_credits,
      unlimited: response.credits.unlimited,
      balance: mapBalance(response.credits.balance)
    },
    rateLimitReachedType: response.rate_limit_reached_type ?? null
  };
}

export function parseUsageResponse(input: unknown): CodexUsage {
  return mapUsageResponse(codexUsageResponseSchema.parse(input));
}

export function classifyUsage(usage: CodexUsage): AppStatus {
  const primaryLeft = usage.rateLimit.primaryWindow.leftPercent;
  const secondaryLeft = usage.rateLimit.secondaryWindow.leftPercent;

  if (usage.rateLimit.limitReached || primaryLeft < 10 || secondaryLeft < 10) {
    return 'Critical quota';
  }

  if (primaryLeft < 30 || secondaryLeft < 30) {
    return 'Low quota';
  }

  return 'OK';
}

export function compareUsage(previous: CodexUsage, current: CodexUsage): UsageComparison {
  return {
    primaryWindowLeftPercentDelta: current.rateLimit.primaryWindow.leftPercent - previous.rateLimit.primaryWindow.leftPercent,
    secondaryWindowLeftPercentDelta: current.rateLimit.secondaryWindow.leftPercent - previous.rateLimit.secondaryWindow.leftPercent
  };
}

export function mapHttpStatusToAppStatus(status: number): AppStatus {
  if (status === 401 || status === 403) {
    return 'Auth required';
  }

  return 'API error';
}
