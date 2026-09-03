import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BackendActionFailure,
  createBackendServer,
  defineBackend,
  type BackendPeer,
  type BackendRuntimeServices,
} from './server.js';
import { BACKEND_PROTOCOL_VERSION, decodeFrame, encodeFrame } from './wire.js';

type Protocol = {
  clientEvents: { move: { x: number } };
  serverEvents: { moved: { x: number }; joined: { id: string } };
  actions: {
    add: { input: { a: number; b: number }; output: number };
    fail: { input: null; output: never };
  };
};

class Peer implements BackendPeer {
  readonly reliable: Uint8Array[] = [];
  readonly unreliable: Uint8Array[] = [];
  readonly identity = {
    playerId: 'player-1',
    username: 'maya',
    displayName: 'Maya',
    avatarUrl: null,
    isGuest: false,
  };
  closeInfo: [number | undefined, string | undefined] | null = null;

  constructor(readonly id: string) {}

  async sendReliable(frame: Uint8Array) {
    this.reliable.push(frame);
  }

  sendUnreliable(frame: Uint8Array) {
    this.unreliable.push(frame);
    return true;
  }

  close(code?: number, reason?: string) {
    this.closeInfo = [code, reason];
  }
}

const services = {
  database: {},
  storage: {},
  fetch,
  region: 'syd',
} as BackendRuntimeServices;

test('server runs lifecycle, events, actions and broadcasts', async () => {
  const seen: string[] = [];
  const definition = defineBackend<Protocol>({
    start: ({ region }) => {
      seen.push(`start:${region}`);
    },
    connect: async (connection, context) => {
      seen.push(`connect:${connection.identity.username}`);
      await context.broadcastReliable('joined', { id: connection.id });
    },
    disconnect: (connection) => {
      seen.push(`disconnect:${connection.id}`);
    },
    messages: {
      move: async (payload, connection, context, delivery) => {
        seen.push(`move:${delivery}:${payload.x}`);
        await context.broadcastReliable('moved', { x: payload.x }, { except: connection.id });
      },
    },
    actions: {
      add: ({ a, b }) => a + b,
      fail: () => {
        throw new BackendActionFailure('not_allowed', 'Not allowed.');
      },
    },
    fetch: (request) => Response.json({ path: new URL(request.url).pathname }),
    shutdown: () => {
      seen.push('shutdown');
    },
  });
  const server = createBackendServer(definition, services);
  const first = new Peer('connection-1');
  const second = new Peer('connection-2');
  await Promise.all([server.accept(first), server.accept(second)]);
  assert.equal(seen.filter((value) => value === 'start:syd').length, 1);
  assert.equal(server.connectionCount, 2);

  await server.receive(
    first.id,
    encodeFrame({
      version: BACKEND_PROTOCOL_VERSION,
      kind: 'event',
      name: 'move',
      payload: { x: 7 },
    }),
    'reliable',
  );
  assert.match(seen.join(','), /move:reliable:7/);
  assert.equal(decodeFrame(second.reliable.at(-1)!).kind, 'event');

  await server.receive(
    first.id,
    encodeFrame({
      version: BACKEND_PROTOCOL_VERSION,
      kind: 'action.request',
      id: 'action-1',
      name: 'add',
      payload: { a: 2, b: 4 },
    }),
    'reliable',
  );
  assert.deepEqual(decodeFrame(first.reliable.at(-1)!), {
    version: 1,
    kind: 'action.result',
    id: 'action-1',
    payload: 6,
  });

  const response = await server.handleFetch(new Request('https://runtime.test/health'));
  assert.deepEqual(await response.json(), { path: '/health' });
  await server.remove(first.id);
  assert.equal(server.connectionCount, 1);
  await server.shutdown();
  assert.deepEqual(second.closeInfo, [1012, 'Server restarting']);
  assert.ok(seen.includes('shutdown'));
});

test('server closes malformed and unreliable action frames', async () => {
  const server = createBackendServer(defineBackend<Protocol>({}), services);
  const malformed = new Peer('malformed');
  await server.accept(malformed);
  await server.receive(malformed.id, new Uint8Array([0xff]), 'reliable');
  assert.deepEqual(malformed.closeInfo, [1008, 'Invalid backend message']);
  assert.equal(server.connectionCount, 0);

  const unreliable = new Peer('unreliable');
  await server.accept(unreliable);
  await server.receive(
    unreliable.id,
    encodeFrame(
      {
        version: BACKEND_PROTOCOL_VERSION,
        kind: 'action.request',
        id: 'action-1',
        name: 'add',
        payload: { a: 1, b: 2 },
      },
      'unreliable',
    ),
    'unreliable',
  );
  assert.deepEqual(unreliable.closeInfo, [1008, 'Actions require reliable delivery']);
});

test('server returns bounded creator errors and hides unexpected failures', async () => {
  const definition = defineBackend<Protocol>({
    actions: {
      add: () => {
        throw new Error('database password must never leak');
      },
      fail: () => {
        throw new BackendActionFailure('denied', 'Safe creator message');
      },
    },
  });
  const server = createBackendServer(definition, services);
  const peer = new Peer('connection');
  await server.accept(peer);
  for (const [id, name] of [
    ['one', 'add'],
    ['two', 'fail'],
  ] as const) {
    await server.receive(
      peer.id,
      encodeFrame({
        version: BACKEND_PROTOCOL_VERSION,
        kind: 'action.request',
        id,
        name,
        payload: name === 'add' ? { a: 1, b: 1 } : null,
      }),
      'reliable',
    );
  }
  const first = decodeFrame(peer.reliable[0]!);
  const second = decodeFrame(peer.reliable[1]!);
  assert.equal(first.kind === 'action.error' && first.error.code, 'internal_error');
  assert.equal(first.kind === 'action.error' && first.error.message, 'The action failed.');
  assert.equal(second.kind === 'action.error' && second.error.message, 'Safe creator message');
});
