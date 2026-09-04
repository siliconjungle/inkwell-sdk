import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeServices } from './storage.js';
import { createBackendServer, defineBackend, type BackendRuntimeServices } from './server.js';

test('backend context presence uses current-game runtime authentication without selectors', async () => {
  let calls = 0;
  const snapshot = { total: 2, guestCount: 1, players: [] };
  const services = createRuntimeServices({ baseUrl: 'https://inkwell.ing', token: 'ink_rt_fixture', fetch: async (url, init) => {
    calls++;
    assert.equal(new URL(String(url)).pathname, '/api/v1/game-services/presence');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ink_rt_fixture');
    assert.deepEqual(JSON.parse(String(init?.body)), { operation: 'get' });
    return Response.json(snapshot);
  } });
  assert.deepEqual(await services.presence.get(), snapshot);
  const server = createBackendServer(defineBackend({ start: async context => {
    assert.deepEqual(await context.presence.get(), snapshot);
    assert.equal(context.connections.length, 0, 'game presence is not backend connection count');
  } }), { ...services, fetch, region: 'test' } as BackendRuntimeServices);
  await server.start();
  assert.equal(calls, 2);
});

test('unavailable backend presence rejects instead of reporting an empty game', async () => {
  const services = createRuntimeServices({ baseUrl: 'https://inkwell.ing', token: 'ink_rt_fixture', fetch: async () =>
    Response.json({ error: 'Presence is temporarily unavailable.' }, { status: 503 }),
  });
  await assert.rejects(services.presence.get(), /temporarily unavailable/);
});
