import assert from 'node:assert/strict';
import test from 'node:test';
import { createModClient, ModApiError } from './mods.js';
test('mod catalog reads never expose developer tokens and owner mutations preserve revisions', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (url, init) => { calls.push({url:String(url),init}); return Response.json({mod:{slug:'my-mod',revision:2},mods:[],nextOffset:null}); }) as typeof fetch;
  const client = createModClient({ token: 'secret', fetch: fetcher });
  await client.browse({baseGame:'Old Game',offset:24});
  assert.equal(new Headers(calls[0]?.init?.headers).has('authorization'),false);
  assert.match(calls[0]!.url,/baseGame=Old\+Game/);
  await client.update('my-mod',{revision:2,visibility:'public',rightsConfirmed:true});
  assert.equal(new Headers(calls[1]?.init?.headers).get('authorization'),'Bearer secret');
  assert.equal(calls[1]?.init?.redirect,'error');
  assert.equal(calls[1]?.init?.credentials,'omit');
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)),{revision:2,visibility:'public',rightsConfirmed:true});
});
test('owner operations reject missing credentials and surface permission/conflict errors', async () => {
  let called = false;
  const fetcher = (async () => { called = true; return Response.json({ error:'Reload the listing.' },{status:409}); }) as typeof fetch;
  await assert.rejects(createModClient({fetch:fetcher}).get('my-mod'),/token/);
  assert.equal(called,false);
  await assert.rejects(createModClient({token:'secret',fetch:fetcher}).get('my-mod'), error => error instanceof ModApiError && error.status === 409);
  for (const apiUrl of ['http://example.com','https://me:secret@example.com','https://example.com/path']) assert.throws(() => createModClient({apiUrl}));
  assert.throws(() => createModClient().getPublic('../keys'),/slug/);
  assert.throws(() => createModClient().browse({offset:-1}),/Offset/);
});
