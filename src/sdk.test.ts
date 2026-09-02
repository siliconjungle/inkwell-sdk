import assert from 'node:assert/strict';
import test from 'node:test';

import { AssetTracker } from './assets.js';
import { track } from './analytics.js';

test('asset tracker aggregates known byte progress', () => {
  const tracker = new AssetTracker();
  tracker.update('a', { loadedBytes: 5, totalBytes: 10 });
  tracker.update('b', { loadedBytes: 10, totalBytes: 10, completed: true });
  assert.equal(tracker.snapshot().ratio, 0.75);
  assert.equal(tracker.snapshot().loadedAssets, 1);
});

test('analytics rejects unsafe event names', () => {
  assert.throws(() => track('not allowed spaces'));
});
