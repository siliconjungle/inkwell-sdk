import { emit } from './protocol.js';

let state: 'loading' | 'ready' | 'failed' = 'loading';

/** Report engine startup progress. null displays an indeterminate loading bar. */
export function progress(ratio: number | null) {
  if (ratio !== null && (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1)) {
    throw new TypeError('Loading progress must be null or a number between 0 and 1.');
  }
  if (state !== 'loading') return false;
  return emit('loading.progress', { ratio });
}

/** Report a player-readable startup failure. A page reload starts a new lifecycle. */
export function fail(message: string) {
  if (typeof message !== 'string' || !message.trim() || message.length > 500) {
    throw new TypeError('Loading failure needs a message of 1 to 500 characters.');
  }
  if (state !== 'loading') return false;
  state = 'failed';
  return emit('loading.error', { message: message.trim() });
}

/** Internal lifecycle shared by ready() and engine loading helpers. */
export function markReady() {
  if (state !== 'loading') return false;
  state = 'ready';
  emit('ready');
  return true;
}

export const loading = Object.freeze({ progress, fail });
