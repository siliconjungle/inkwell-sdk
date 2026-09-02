import { emit } from './protocol.js';

export type AssetProgress = {
  id: string;
  loadedBytes: number;
  totalBytes: number | null;
  completed: boolean;
  failed: boolean;
};

export type AggregateAssetProgress = {
  assets: readonly AssetProgress[];
  loadedAssets: number;
  totalAssets: number;
  loadedBytes: number;
  totalBytes: number | null;
  ratio: number | null;
};

export class AssetTracker {
  readonly #assets = new Map<string, AssetProgress>();
  readonly #listeners = new Set<(progress: AggregateAssetProgress) => void>();

  subscribe(listener: (progress: AggregateAssetProgress) => void) {
    this.#listeners.add(listener);
    listener(this.snapshot());
    return () => this.#listeners.delete(listener);
  }

  update(id: string, update: Partial<Omit<AssetProgress, 'id'>>) {
    const current = this.#assets.get(id) || { id, loadedBytes: 0, totalBytes: null, completed: false, failed: false };
    this.#assets.set(id, { ...current, ...update, id });
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
    emit('assets.progress', { loadedAssets: snapshot.loadedAssets, totalAssets: snapshot.totalAssets, ratio: snapshot.ratio });
    return snapshot;
  }

  snapshot(): AggregateAssetProgress {
    const assets = [...this.#assets.values()];
    const loadedBytes = assets.reduce((sum, asset) => sum + asset.loadedBytes, 0);
    const knownTotals = assets.every((asset) => asset.totalBytes != null);
    const totalBytes = knownTotals ? assets.reduce((sum, asset) => sum + (asset.totalBytes || 0), 0) : null;
    return {
      assets,
      loadedAssets: assets.filter((asset) => asset.completed).length,
      totalAssets: assets.length,
      loadedBytes,
      totalBytes,
      ratio: totalBytes && totalBytes > 0 ? Math.min(1, loadedBytes / totalBytes) : assets.length ? assets.filter((asset) => asset.completed).length / assets.length : null,
    };
  }
}

export const defaultTracker = new AssetTracker();

/** A normal fetch that reports byte progress as its response body is consumed. */
export async function trackedFetch(input: RequestInfo | URL, init?: RequestInit & { tracker?: AssetTracker; assetId?: string }) {
  const { tracker = defaultTracker, assetId, ...fetchInit } = init || {};
  const id = assetId || (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  tracker.update(id, { loadedBytes: 0, completed: false, failed: false });
  try {
    const response = await fetch(input, fetchInit);
    const totalHeader = response.headers.get('content-length');
    const totalBytes = totalHeader ? Number(totalHeader) : null;
    if (!response.body) {
      tracker.update(id, { loadedBytes: totalBytes || 0, totalBytes, completed: true });
      return response;
    }
    const reader = response.body.getReader();
    let loadedBytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = await reader.read();
        if (chunk.done) {
          tracker.update(id, { loadedBytes, totalBytes, completed: true });
          controller.close();
          return;
        }
        loadedBytes += chunk.value.byteLength;
        tracker.update(id, { loadedBytes, totalBytes });
        controller.enqueue(chunk.value);
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    tracker.update(id, { failed: true, completed: true });
    throw error;
  }
}

/** Lets an engine loader participate in the same aggregate progress tracker. */
export async function trackPromise<T>(id: string, promise: Promise<T>, tracker = defaultTracker) {
  tracker.update(id, { completed: false, failed: false });
  try {
    const value = await promise;
    tracker.update(id, { completed: true });
    return value;
  } catch (error) {
    tracker.update(id, { completed: true, failed: true });
    throw error;
  }
}

export const assets = Object.freeze({ AssetTracker, defaultTracker, trackedFetch, trackPromise });
