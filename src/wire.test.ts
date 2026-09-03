import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BACKEND_PROTOCOL_VERSION,
  BackendProtocolError,
  decodeFrame,
  encodeFrame,
  frameReliablePayload,
  MAX_UNRELIABLE_FRAME_BYTES,
  ReliableFrameDecoder,
} from './wire.js';

function event(payload: unknown = null) {
  return {
    version: BACKEND_PROTOCOL_VERSION,
    kind: 'event' as const,
    name: 'state.update',
    payload,
  };
}

test('reliable framing survives fragmentation and coalescing', () => {
  const first = frameReliablePayload(encodeFrame(event({ n: 1 })));
  const second = frameReliablePayload(encodeFrame(event({ n: 2 })));
  const combined = new Uint8Array(first.length + second.length);
  combined.set(first);
  combined.set(second, first.length);
  const decoder = new ReliableFrameDecoder();
  assert.equal(decoder.push(combined.slice(0, 3)).length, 0);
  assert.equal(decoder.push(combined.slice(3, first.length - 1)).length, 0);
  const frames = decoder.push(combined.slice(first.length - 1));
  assert.equal(frames.length, 2);
  assert.deepEqual(decodeFrame(frames[0]!), event({ n: 1 }));
  assert.deepEqual(decodeFrame(frames[1]!), event({ n: 2 }));
});

test('wire decoder rejects invalid UTF-8, action identifiers and oversized datagrams', () => {
  assert.throws(() => decodeFrame(new Uint8Array([0xff])), BackendProtocolError);
  assert.throws(
    () =>
      decodeFrame(
        new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            kind: 'action.result',
            id: '../unsafe',
            payload: null,
          }),
        ),
      ),
    BackendProtocolError,
  );
  assert.throws(
    () => decodeFrame(new Uint8Array(MAX_UNRELIABLE_FRAME_BYTES + 1), 'unreliable'),
    BackendProtocolError,
  );
});
