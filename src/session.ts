import { emit } from './protocol.js';

let completeSent = false;

/** Records the current play session as completed. Idempotent per page load. */
export function complete() {
  if (completeSent) return false;
  completeSent = true;
  emit('session.complete');
  return true;
}

export const session = Object.freeze({ complete });
