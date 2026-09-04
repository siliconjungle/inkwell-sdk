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

test('engine config preserves deployment contract and rejects unsafe browser options', () => {
  const config = validateGameConfig({
    game: 'space-game',
    client: { directory: 'export', entrypoint: 'web/game.html', engine: { name: 'godot', version: '4.5' }, capabilities: { threads: true }, startup: { mode: 'handshake', timeoutMs: 90_000 } },
  });
  assert.equal(config.game, 'space-game');
  assert.equal(config.client.entrypoint, 'web/game.html');
  assert.equal(config.client.capabilities?.threads, true);
  for (const client of [
    { entrypoint: '../game.html' }, { entrypoint: 'game.js' }, { entrypoint: 'game.html?foo' },
    { engine: { name: 'windows' } }, { engine: { name: 'unity', version: '' } },
    { capabilities: { threads: 'yes' } }, { startup: { mode: 'always' } },
    { startup: { mode: 'handshake', timeoutMs: 1 } },
  ]) assert.throws(() => validateGameConfig({ client: { directory: 'dist', ...client } }));
});
