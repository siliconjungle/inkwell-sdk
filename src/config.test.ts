import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defineGameConfig,
  INKWELL_BACKEND_IDLE_GRACE_SECONDS,
  validateGameConfig,
} from './config.js';

test('game config validates an optional creator backend', () => {
  const config = defineGameConfig({
    client: { directory: 'dist' },
    backend: {
      entry: 'server/index.ts',
      region: 'syd',
      maxConnections: 250,
      resources: { memoryMb: 512, sharedCpus: 1 },
    },
  });
  assert.equal(config.backend?.region, 'syd');
  assert.equal(INKWELL_BACKEND_IDLE_GRACE_SECONDS, 300);
});

test('game config rejects traversal and unsafe resource limits', () => {
  assert.throws(
    () => validateGameConfig({ client: { directory: '../private' } }),
    /relative path/,
  );
  assert.throws(
    () =>
      validateGameConfig({
        client: { directory: 'dist' },
        backend: { entry: 'server.ts', resources: { memoryMb: 99_999 } },
      }),
    /not supported/,
  );
});
