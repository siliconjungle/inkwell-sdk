import { requestGameService } from './game-services.js';

export type GameInfo = {
  slug: string;
  title: string;
  websiteUrl: string | null;
  discordUrl: string | null;
};

/** Read the current game's public links and identity from the trusted host. */
export function get(): Promise<GameInfo> {
  return requestGameService<GameInfo>('game', { operation: 'get' });
}

export const game = Object.freeze({ get });
