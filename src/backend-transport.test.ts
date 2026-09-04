import assert from 'node:assert/strict';
import test from 'node:test';
import { connectBackend, WebTransportBackendTransport } from './backend.js';

test('direct WebTransport passes exact certificate pins and requires QUIC', async (t) => {
  let options: WebTransportOptions | undefined;
  const writes: Uint8Array[] = [];
  class Transport {
    ready = Promise.resolve();
    closed = new Promise(() => {});
    datagrams = {
      maxDatagramSize: 1180,
      readable: new ReadableStream(),
      writable: new WritableStream(),
    };
    constructor(_url: string, value: WebTransportOptions) { options = value; }
    async createBidirectionalStream() {
      return {
        readable: new ReadableStream(),
        writable: new WritableStream({ write: (value) => { writes.push(value); } }),
      };
    }
    close() {}
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebTransport');
  Object.defineProperty(globalThis, 'WebTransport', { value: Transport, configurable: true });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'WebTransport', original);
    else Reflect.deleteProperty(globalThis, 'WebTransport');
  });
  const hash = '0123456789abcdef'.repeat(4);
  const connection = await WebTransportBackendTransport.connect(
    'https://games.example:10001/connect?ticket=test', 1000, undefined, [hash],
  );
  assert.equal(options?.requireUnreliable, true);
  assert.equal(options?.allowPooling, false);
  const pins = options?.serverCertificateHashes;
  assert.equal(pins?.length, 1);
  assert.equal(pins![0]!.algorithm, 'sha-256');
  assert.equal(Buffer.from(pins![0]!.value as ArrayBuffer).toString('hex'), hash);
  assert.equal(connection.capabilities.unreliable, 'native');
  assert.equal(connection.capabilities.maxUnreliableFrameBytes, 1180);
  assert.deepEqual(writes, [new Uint8Array(4)]);
  connection.close();

  const legacy = await WebTransportBackendTransport.connect('https://gateway.example/connect', 1000);
  assert.equal(legacy.capabilities.unreliable, 'emulated');
  legacy.close();

  const events = new EventTarget();
  let descriptor: Record<string, unknown> = {
    transport: 'webtransport', url: 'https://games.example:10001/connect?ticket=one-shot',
    serverCertificateHashes: [hash],
  };
  const parent = { postMessage(message: { payload: { requestId: string } }) {
    const event = new Event('message');
    Object.assign(event, { source: parent, origin: 'https://inkwell.ing', data: {
      source: 'inkwell-platform', version: 1, type: 'backend.result',
      payload: { requestId: message.payload.requestId, descriptor },
    } });
    events.dispatchEvent(event);
  } };
  for (const [name, value] of Object.entries({
    window: { parent, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) },
    document: { referrer: 'https://inkwell.ing/games/test/play' },
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const throughPlayer = await connectBackend({ connectTimeoutMs: 1000 });
  assert.equal(throughPlayer.capabilities.unreliable, 'native');
  throughPlayer.close();
  descriptor = { ...descriptor, fallbackUrl: 'wss://gateway.example/ws' };
  await assert.rejects(connectBackend({ connectTimeoutMs: 1000 }), /requires direct WebTransport/);
});

test('rejects malformed certificate descriptors before opening a network connection', async () => {
  for (const pins of [[], ['a'.repeat(63)], ['g'.repeat(64)], Array(3).fill('a'.repeat(64))]) {
    await assert.rejects(
      WebTransportBackendTransport.connect('https://games.example:10001', 1000, undefined, pins),
      /Invalid backend certificate/,
    );
  }
});
