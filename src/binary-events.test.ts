import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendConnection, type BackendTransport } from './backend.js';
import {
  createBackendServer,
  defineBackend,
  type BackendRuntimeServices,
} from './server.js';
import {
  binaryEventOverhead,
  decodeFrame,
  encodeBinaryEvent,
  encodeFrame,
  BINARY_NEGOTIATION_ACTION,
  BackendProtocolError,
  ReliableFrameDecoder,
  frameReliablePayload,
} from './wire.js';

test('binary event framing handles views, empty data, strict headers and exact budgets', () => {
  const source = Uint8Array.of(8, 0, 255, 7),
    payload = source.subarray(1, 3);
  const bytes = encodeBinaryEvent(
    'motion',
    payload,
    'unreliable',
    binaryEventOverhead('motion') + 2,
  );
  source[1] = 99;
  assert.deepEqual(decodeFrame(bytes, 'unreliable'), {
    version: 1,
    kind: 'event.binary',
    name: 'motion',
    payload: Uint8Array.of(0, 255),
  });
  assert.deepEqual(
    (
      decodeFrame(encodeBinaryEvent('x', new Uint8Array())) as {
        payload: unknown;
      }
    ).payload,
    new Uint8Array(),
  );
  assert.equal(
    encodeBinaryEvent('x', new Uint8Array(1018), 'unreliable', 1024).length,
    1024,
  );
  assert.throws(
    () => encodeBinaryEvent('x', new Uint8Array(1019), 'unreliable', 1024),
    BackendProtocolError,
  );
  for (const malformed of [
    bytes.slice(0, 4),
    Uint8Array.of(73, 66, 69, 2, 1, 120),
    Uint8Array.of(73, 66, 69, 1, 81),
    Uint8Array.of(73, 66, 69, 1, 2, 255, 255),
    Uint8Array.of(73, 66, 69, 1, 0),
    new Uint8Array(1201),
  ])
    assert.throws(
      () => decodeFrame(malformed, 'unreliable'),
      BackendProtocolError,
    );
  assert.throws(
    () => encodeBinaryEvent('bad/name', payload),
    BackendProtocolError,
  );
  assert.throws(
    () =>
      decodeFrame(
        encodeFrame({
          version: 1,
          kind: 'event',
          name: 'x',
          payload: null,
        }).map((x, i) => (i === 0 ? 73 : x)),
      ),
    BackendProtocolError,
  );
  const reliable = frameReliablePayload(bytes),
    parser = new ReliableFrameDecoder();
  assert.equal(parser.push(reliable.subarray(0, 5)).length, 0);
  assert.deepEqual(parser.push(reliable.subarray(5)), [bytes]);
});

function setup(optIn = true) {
  let handlers: Parameters<BackendTransport['setHandlers']>[0];
  const reliable: Uint8Array[] = [],
    unreliable: Uint8Array[] = [],
    received: unknown[] = [];
  let closed = false;
  const transport: BackendTransport = {
    kind: 'custom',
    capabilities: { unreliable: 'native', maxUnreliableFrameBytes: 1024 },
    setHandlers(h) {
      handlers = h;
    },
    async sendReliable(b) {
      reliable.push(b);
    },
    sendUnreliable(b) {
      unreliable.push(b);
      return true;
    },
    close() {
      closed = true;
    },
  };
  const client = new BackendConnection(transport);
  const server = createBackendServer(
    defineBackend({
      binaryEvents: optIn,
      binaryMessages: {
        echo: async (b, c, _ctx, d) => {
          received.push([b, d]);
          if (d === 'reliable') await c.sendBinaryReliable('reply', b);
          else c.sendBinaryUnreliable('reply', b);
        },
      },
      messages: {
        echo: (b) => {
          received.push(['json', b]);
        },
      },
    }),
    { fetch, region: 'syd' } as BackendRuntimeServices,
  );
  const peer = {
    id: 'p',
    identity: {
      playerId: 'trusted',
      username: null,
      displayName: 'Player',
      avatarUrl: null,
      isGuest: true,
    },
    async sendReliable(b: Uint8Array) {
      handlers.frame(b, 'reliable');
    },
    sendUnreliable(b: Uint8Array) {
      handlers.frame(b, 'unreliable');
      return true;
    },
    close() {
      closed = true;
    },
  };
  return {
    client,
    server,
    peer,
    reliable,
    unreliable,
    received,
    get handlers() {
      return handlers;
    },
    get closed() {
      return closed;
    },
  };
}

test('negotiated client/server exchange binary separately from JSON on both delivery channels', async () => {
  const h = setup(),
    connection = await h.server.accept(h.peer),
    replies: unknown[] = [];
  h.client.onBinary('reply', (b, d) => replies.push([Array.from(b), d]));
  assert.throws(
    () => h.client.sendBinaryUnreliable('echo', new Uint8Array()),
    /negotiated/,
  );
  assert.throws(
    () => connection!.sendBinaryReliable('echo', new Uint8Array()),
    /negotiated/,
  );
  const ready = h.client.negotiateBinaryEvents();
  assert.equal(ready, h.client.negotiateBinaryEvents());
  await h.server.receive('p', h.reliable.shift()!, 'reliable');
  assert.equal(await ready, true);
  assert.equal(connection!.binaryEvents, true);
  await h.client.sendBinaryReliable('echo', Uint8Array.of(0, 255));
  await h.server.receive('p', h.reliable.shift()!, 'reliable');
  h.client.sendBinaryUnreliable('echo', Uint8Array.of(17));
  await h.server.receive('p', h.unreliable.shift()!, 'unreliable');
  await h.client.sendReliable('echo', { x: 1 });
  await h.server.receive('p', h.reliable.shift()!, 'reliable');
  assert.deepEqual(replies, [
    [[0, 255], 'reliable'],
    [[17], 'unreliable'],
  ]);
  assert.deepEqual(h.received.at(-1), ['json', { x: 1 }]);
  assert.throws(
    () => h.client.sendBinaryUnreliable('echo', new Uint8Array(1024)),
    /limit/,
  );
  h.client.close();
  assert.equal(h.client.binaryEvents, false);
  await h.server.shutdown();
});

test('negotiation fallback, timeout and disconnect do not enable binary', async () => {
  const h = setup(false);
  await h.server.accept(h.peer);
  const ready = h.client.negotiateBinaryEvents();
  await h.server.receive('p', h.reliable.shift()!, 'reliable');
  assert.equal(await ready, false);
  assert.throws(
    () => h.client.sendBinaryReliable('echo', new Uint8Array()),
    /negotiated/,
  );
  const old = setup();
  const fallback = old.client.negotiateBinaryEvents();
  const request = decodeFrame(old.reliable.shift()!);
  if (request.kind !== 'action.request') throw Error('action');
  old.handlers.frame(
    encodeFrame({
      version: 1,
      kind: 'action.error',
      id: request.id,
      error: { code: 'unknown_action', message: 'Unknown action' },
    }),
    'reliable',
  );
  assert.equal(await fallback, false);
  const silent = setup(),
    timed = silent.client.negotiateBinaryEvents({ timeoutMs: 5 });
  const late = decodeFrame(silent.reliable.shift()!);
  if (late.kind !== 'action.request') throw Error('action');
  assert.equal(await timed, false);
  silent.handlers.frame(
    encodeFrame({
      version: 1,
      kind: 'action.result',
      id: late.id,
      payload: { version: 1 },
    }),
    'reliable',
  );
  assert.equal(silent.client.binaryEvents, false);
  const disconnected = setup();
  const pending = disconnected.client.negotiateBinaryEvents();
  disconnected.client.close();
  await assert.rejects(pending, /closed/);
  await h.server.shutdown();
});

test('coalesced negotiation response enables reliable binary immediately; early datagrams are discarded', async () => {
  const h = setup(),
    seen: number[] = [];
  h.client.onBinary('reply', (b) => seen.push(b[0]!));
  const ready = h.client.negotiateBinaryEvents();
  const request = decodeFrame(h.reliable.shift()!);
  if (request.kind !== 'action.request') throw Error('action');
  h.handlers.frame(encodeBinaryEvent('reply', Uint8Array.of(1)), 'unreliable');
  h.handlers.frame(
    encodeFrame({
      version: 1,
      kind: 'action.result',
      id: request.id,
      payload: { version: 1 },
    }),
    'reliable',
  );
  h.handlers.frame(encodeBinaryEvent('reply', Uint8Array.of(2)), 'reliable');
  assert.equal(await ready, true);
  await new Promise<void>((r) => queueMicrotask(r));
  assert.deepEqual(seen, [2]);
});

test('unnegotiated binary and unreliable capability actions are rejected server-side', async () => {
  const h = setup();
  await h.server.accept(h.peer);
  await h.server.receive(
    'p',
    encodeBinaryEvent('echo', Uint8Array.of(1)),
    'unreliable',
  );
  assert.equal(h.closed, true);
  assert.equal(h.server.connectionCount, 0);
  const bad = setup();
  await bad.server.accept(bad.peer);
  await bad.server.receive(
    'p',
    encodeFrame({
      version: 1,
      kind: 'action.request',
      id: 'cap',
      name: BINARY_NEGOTIATION_ACTION,
      payload: { version: 1 },
    }),
    'unreliable',
  );
  assert.equal(bad.closed, true);
});
