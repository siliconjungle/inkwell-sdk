import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeServices, RuntimeServiceError } from './storage.js';

test('database calls are scoped with an unoverrideable runtime credential', async () => {
  const captured: { request?: Request } = {};
  const services = createRuntimeServices({
    baseUrl: 'https://runtime.inkwell.test',
    token: 'scoped-token',
    fetch: async (input, init) => {
      captured.request = new Request(input, init);
      return Response.json({ results: [{ results: [{ value: 1 }], meta: {} }] });
    },
  });
  const result = await services.database.query<{ value: number }>(
    'SELECT ? AS value',
    [1],
  );
  assert.equal(result.results[0]?.value, 1);
  assert.equal(
    captured.request?.headers.get('authorization'),
    'Bearer scoped-token',
  );
  assert.equal(
    new URL(captured.request!.url).pathname,
    '/api/v1/runtime/database/query',
  );
});

test('object storage validates paths and preserves UTF-8 metadata', async () => {
  let metadata = '';
  let length = '';
  let worldId = '';
  const services = createRuntimeServices({
    baseUrl: 'https://runtime.inkwell.test',
    token: 'token',
    fetch: async (input, init) => {
      const request = new Request(input, init);
      metadata = request.headers.get('x-inkwell-metadata') ?? '';
      length = request.headers.get('x-inkwell-content-length') ?? '';
      worldId = request.headers.get('x-inkwell-world-id') ?? '';
      return Response.json({
        key: 'world/snapshot.json',
        size: 2,
        etag: 'etag',
        uploadedAt: new Date(0).toISOString(),
        contentType: 'application/json',
        metadata: {},
      });
    },
  });
  await services.storage.put('world/snapshot.json', '{}', {
    metadata: { title: '世界' },
    worldId: 'world:one',
  });
  assert.equal(length, '2');
  assert.equal(worldId, 'world:one');
  assert.equal(
    new TextDecoder().decode(Uint8Array.from(atob(metadata), (char) => char.charCodeAt(0))),
    JSON.stringify({ title: '世界' }),
  );
  await assert.rejects(
    Promise.resolve().then(() => services.storage.put('../secret', 'x')),
    /safe relative paths/,
  );
});

test('stream uploads require a declared size', async () => {
  const services = createRuntimeServices({
    baseUrl: 'https://runtime.inkwell.test',
    token: 'token',
    fetch: async () => Response.json({}),
  });
  const stream = new ReadableStream<Uint8Array>();
  await assert.rejects(services.storage.put('stream.bin', stream), /explicit size/);
});

test('runtime service errors are bounded and timeouts abort requests', async () => {
  const rejected = createRuntimeServices({
    baseUrl: 'https://runtime.inkwell.test',
    token: 'token',
    fetch: async () => Response.json({ code: 'quota', error: 'Full' }, { status: 429 }),
  });
  await assert.rejects(rejected.database.query('SELECT 1'), (error: unknown) => {
    assert.ok(error instanceof RuntimeServiceError);
    assert.equal(error.status, 429);
    assert.equal(error.code, 'quota');
    return true;
  });

  const timedOut = createRuntimeServices({
    baseUrl: 'https://runtime.inkwell.test',
    token: 'token',
    timeoutMs: 5,
    fetch: (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
  });
  await assert.rejects(timedOut.database.query('SELECT 1'), (error: unknown) => {
    assert.ok(error instanceof RuntimeServiceError);
    assert.equal(error.code, 'timeout');
    return true;
  });
});
