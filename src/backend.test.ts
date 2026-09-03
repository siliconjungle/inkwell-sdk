import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BackendActionError,
  BackendConnection,
  BackendConnectionError,
  requestBackend,
  type BackendTransport,
} from './backend.js';
import { BACKEND_PROTOCOL_VERSION, decodeFrame, encodeFrame } from './wire.js';

type Protocol = {
  clientEvents: { move: { x: number } };
  serverEvents: { notice: { text: string } };
  actions: { add: { input: { a: number; b: number }; output: number } };
};

class MockTransport implements BackendTransport {
  readonly kind = 'custom' as const;
  readonly capabilities = {
    unreliable: 'native' as const,
    maxUnreliableFrameBytes: 1_200,
  };
  handlers: Parameters<BackendTransport['setHandlers']>[0] = {
    frame: () => undefined,
    close: () => undefined,
  };
  reliable: Uint8Array[] = [];
  unreliable: Uint8Array[] = [];
  closed = false;

  setHandlers(handlers: Parameters<BackendTransport['setHandlers']>[0]) {
    this.handlers = handlers;
  }

  async sendReliable(frame: Uint8Array) {
    this.reliable.push(frame);
  }

  sendUnreliable(frame: Uint8Array) {
    this.unreliable.push(frame);
    return true;
  }

  close() {
    this.closed = true;
  }
}

test('typed client events and actions use the expected delivery channels', async () => {
  const transport = new MockTransport();
  const connection = new BackendConnection<Protocol>(transport);
  let notice = '';
  connection.on('notice', (payload) => {
    notice = payload.text;
  });

  await connection.sendReliable('move', { x: 1 });
  assert.equal(decodeFrame(transport.reliable[0]!).kind, 'event');
  assert.equal(connection.sendUnreliable('move', { x: 2 }), true);
  assert.equal(decodeFrame(transport.unreliable[0]!, 'unreliable').kind, 'event');

  transport.handlers.frame(
    encodeFrame({
      version: BACKEND_PROTOCOL_VERSION,
      kind: 'event',
      name: 'notice',
      payload: { text: 'hello' },
    }),
    'reliable',
  );
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(notice, 'hello');

  const action = connection.action('add', { a: 2, b: 3 });
  const request = decodeFrame(transport.reliable.at(-1)!);
  assert.equal(request.kind, 'action.request');
  if (request.kind !== 'action.request') throw new Error('Expected action request.');
  transport.handlers.frame(
    encodeFrame({
      version: BACKEND_PROTOCOL_VERSION,
      kind: 'action.result',
      id: request.id,
      payload: 5,
    }),
    'reliable',
  );
  assert.equal(await action, 5);
  assert.equal(connection.capabilities.unreliable, 'native');
});

test('action errors, aborts and connection closure reject pending work', async () => {
  const transport = new MockTransport();
  const connection = new BackendConnection<Protocol>(transport, 1_000);
  const failed = connection.action('add', { a: 1, b: 1 });
  const request = decodeFrame(transport.reliable[0]!);
  if (request.kind !== 'action.request') throw new Error('Expected action request.');
  transport.handlers.frame(
    encodeFrame({
      version: BACKEND_PROTOCOL_VERSION,
      kind: 'action.error',
      id: request.id,
      error: { code: 'denied', message: 'Nope' },
    }),
    'reliable',
  );
  await assert.rejects(failed, (error: unknown) => {
    assert.ok(error instanceof BackendActionError);
    assert.equal(error.code, 'denied');
    return true;
  });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    connection.action('add', { a: 1, b: 1 }, { signal: controller.signal }),
    /cancelled/i,
  );

  const pending = connection.action('add', { a: 1, b: 1 });
  transport.handlers.close(new BackendConnectionError('gone'));
  await assert.rejects(pending, /gone/);
  assert.throws(() => connection.sendUnreliable('move', { x: 1 }), /closed/);
});

test('backend request bridge preserves binary bodies without exposing session credentials', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const events = new EventTarget();
  let observed: Record<string, unknown> | undefined;
  const parent = {
    postMessage(message: unknown) {
      observed = message as Record<string, unknown>;
      const payload = observed.payload as {
        requestId: string;
        request: { body: string };
      };
      const responseEvent = new Event('message') as Event & {
        source: unknown;
        origin: string;
        data: unknown;
      };
      Object.assign(responseEvent, {
        source: parent,
        origin: 'https://inkwell.ing',
        data: {
          source: 'inkwell-platform',
          version: 1,
          type: 'backend.fetch.result',
          payload: {
            requestId: payload.requestId,
            response: {
              status: 201,
              headers: { 'content-type': 'application/octet-stream' },
              body: payload.request.body,
            },
          },
        },
      });
      queueMicrotask(() => events.dispatchEvent(responseEvent));
    },
  };
  const fakeWindow = {
    parent,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: fakeWindow,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { referrer: 'https://inkwell.ing/games/example/play' },
  });
  try {
    const response = await requestBackend('/save', {
      method: 'POST',
      body: new Uint8Array([0, 1, 2, 255]),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(
      Array.from(new Uint8Array(await response.arrayBuffer())),
      [0, 1, 2, 255],
    );
    assert.equal(observed?.type, 'backend.fetch');
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
