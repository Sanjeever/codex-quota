import type { DebugState } from './types';

function maskEmail(email: string | null | undefined): string | null {
  if (!email) {
    return null;
  }

  const [local, domain] = email.split('@');
  if (!local || !domain) {
    return '[redacted]';
  }

  return `${local[0]}***@${domain}`;
}

export function redactDebugState(state: DebugState): DebugState {
  if (!state.usage) {
    return state;
  }

  return {
    ...state,
    usage: {
      ...state.usage,
      userId: state.usage.userId ? '[redacted]' : null,
      accountId: state.usage.accountId ? '[redacted]' : null,
      email: maskEmail(state.usage.email)
    }
  };
}

export function toDebugJson(state: DebugState): string {
  return JSON.stringify(redactDebugState(state), null, 2);
}
