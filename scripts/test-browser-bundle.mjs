import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../dist/inkwell.browser.js', import.meta.url), 'utf8');
function boot() {
  const messages = [];
  const context = vm.createContext({ window: { parent: { postMessage: m => messages.push(m) } }, document: { referrer: 'https://inkwell.ing/games/test/play' }, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  assert.equal(messages.length, 0, 'loading the bundle must not mark a game ready');
  return { sdk: context.window.Inkwell, messages };
}
const normal = boot();
normal.sdk.loading.progress(0.25);
normal.sdk.ready();
assert.deepEqual(normal.messages.map(m => m.type), ['loading.progress', 'ready']);
const failed = boot();
failed.sdk.loading.fail('Cannot initialize renderer.');
assert.equal(failed.sdk.ready(), false);
assert.deepEqual(failed.messages.map(m => m.type), ['loading.error']);
for (const name of ['backend', 'chat', 'player', 'stats', 'leaderboards', 'achievements']) assert.ok(normal.sdk[name], `missing ${name}`);
console.log('Standalone browser bundle: ready/failure lifecycles and engine services verified.');
