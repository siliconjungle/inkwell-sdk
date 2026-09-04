import { requestGameService, type GameServiceRequest } from './game-services.js';

export type QueuedGameWrite = { queued: true; requestId: string };
export type CachedGameRead = { offline?: boolean; cachedAt?: number; pendingWrites?: number };
export type OfflineStatus = { enabled: boolean; pending: number; failures: { id: string; error: string; at: number }[] };

/** Opt-in browser save queue stored by the host, never by an untrusted game origin. */
export function createOffline(request: GameServiceRequest = requestGameService) {
  return Object.freeze({
    enable: () => request<OfflineStatus>('offline', { operation: 'enable' }),
    disable: () => request<OfflineStatus>('offline', { operation: 'disable' }),
    status: () => request<OfflineStatus>('offline', { operation: 'status' }),
    flush: () => request<{ pending: number; failures: number }>('offline', { operation: 'flush' }),
  });
}
export const offline = createOffline();
