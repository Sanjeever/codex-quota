import type { DebugState } from './types';

export function toDebugJson(state: DebugState): string {
  return JSON.stringify(state, null, 2);
}
