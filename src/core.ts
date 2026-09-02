import { emit } from './protocol.js';

let readySent = false;

/** Signals that the game has finished its own startup and is interactive. Idempotent. */
export function ready() {
  if (readySent) return false;
  readySent = true;
  emit('ready');
  return true;
}
