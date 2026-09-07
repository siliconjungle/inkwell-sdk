import { requestGameService } from './game-services.js';

/** Open the host's feedback form. The player signs in and submits it themselves.
 * Resolves when opened, not when feedback is submitted. No feedback text or
 * creator inbox data is exposed to the game. Call from a player interaction.
 */
export function open(): Promise<{ opened: true }> {
  return requestGameService('feedback', { operation: 'open' });
}

export const feedback = Object.freeze({ open });
