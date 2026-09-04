import assert from 'node:assert/strict';
import test from 'node:test';
import { getAccepted, onAccepted, setContextProvider, validateInviteContext } from './invites.js';

test('invite context is bounded JSON, copied and not arbitrary code or authority', () => {
  const input = { room: { id: 'one' } };
  const value = validateInviteContext(input);
  input.room.id = 'two';
  assert.deepEqual(value, { room: { id: 'one' } });
  for (const invalid of [[], { n: Infinity }, { fn: () => {} }, { text: '💡'.repeat(1100) }, JSON.parse('{"__proto__":{}}')]) assert.throws(() => validateInviteContext(invalid));
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.throws(() => validateInviteContext(cyclic));
});

test('invites authenticate parent messages, clean subscriptions and reject stale providers', async () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis,'window');
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis,'document');
  const listeners = new Set<(event: unknown) => void>();
  const sent: {type:string;payload:Record<string,unknown>}[] = [];
  const parent = { postMessage(message: typeof sent[number], origin: string) { assert.equal(origin,'https://inkwell.ing'); sent.push(message); } };
  Object.defineProperty(globalThis,'window',{configurable:true,value:{parent,addEventListener:(_:string,fn:(event:unknown)=>void)=>listeners.add(fn),removeEventListener:(_:string,fn:(event:unknown)=>void)=>listeners.delete(fn)}});
  Object.defineProperty(globalThis,'document',{configurable:true,value:{referrer:'https://inkwell.ing/games/one/play'}});
  const emit = (type: string, payload: Record<string,unknown>, source: unknown = parent, origin = 'https://inkwell.ing') => { for(const fn of [...listeners]) fn({source,origin,data:{source:'inkwell-platform',version:1,type,payload}}); };
  const tick = () => new Promise(resolve => setImmediate(resolve));
  let clear = () => {};
  try {
    let calls = 0;
    clear = setContextProvider(() => { ++calls; return { room:'one' }; });
    emit('invites.context.request',{requestId:'bad'},{});
    emit('invites.context.request',{requestId:'bad'},parent,'https://evil.test');
    await tick(); assert.equal(calls,0);
    emit('invites.context.request',{requestId:'good'}); await tick();
    assert.equal(calls,1); assert.deepEqual(sent.at(-1)?.payload,{requestId:'good',context:{room:'one'}});
    let finish!: (value:{room:string}) => void;
    clear = setContextProvider(() => new Promise(resolve => { finish = resolve; }));
    emit('invites.context.request',{requestId:'stale'}); await tick();
    clear(); finish({room:'stale'}); await tick();
    assert(!sent.some(message => message.type==='invites.context.result' && message.payload.requestId==='stale'));
    const pending = getAccepted(); const id = sent.at(-1)!.payload.requestId;
    emit('invites.accepted.result',{requestId:id,invitation:null},{});
    assert.equal(listeners.size,1);
    emit('invites.accepted.result',{requestId:id,invitation:null}); assert.equal(await pending,null); assert.equal(listeners.size,0);
    const notices: unknown[] = [];
    const stop = onAccepted(invite => { notices.push(invite); });
    const secondId = sent.at(-1)!.payload.requestId;
    const invitation = { id:'a'.repeat(32),gameSlug:'one',from:{username:'alice',playerId:'opaque',secret:'strip'},context:{room:'one'},createdAt:new Date().toISOString(),acceptedAt:new Date().toISOString(),expiresAt:new Date().toISOString(),accountId:'strip' };
    emit('invites.accepted.result',{requestId:secondId,invitation}); await tick();
    assert.equal(notices.length,1); assert(!('accountId' in (notices[0] as object))); stop();
    const cancel = onAccepted(() => { throw new Error('Must not run'); }); cancel(); await tick(); assert.equal(listeners.size,0);
    const controller = new AbortController(); const aborted = getAccepted({signal:controller.signal}); controller.abort(); await assert.rejects(aborted,/cancelled/); assert.equal(listeners.size,0);
  } finally {
    clear();
    if(oldWindow) Object.defineProperty(globalThis,'window',oldWindow); else Reflect.deleteProperty(globalThis,'window');
    if(oldDocument) Object.defineProperty(globalThis,'document',oldDocument); else Reflect.deleteProperty(globalThis,'document');
  }
});
