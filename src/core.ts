import { markReady } from './loading.js';

/** Signals that the game has finished its own startup and is interactive. Idempotent. */
export function ready() {
  return markReady();
}
