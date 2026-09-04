import assert from 'node:assert/strict';
import test from 'node:test';
import { createChat, createServerChat, type ChatMessage } from './chat.js';
import type { GameServiceRequest } from './game-services.js';

const message = (sequence: number): ChatMessage => ({ id: `message-${sequence}`, sequence, channel: 'game', senderId: 'p_1', author: { displayName: 'NPC' }, body: 'hello', recipients: [], createdAt: new Date().toISOString() });
class FakeSocket {
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror = null;
  commands: Record<string, unknown>[] = [];
  constructor(private history: ChatMessage[], private removedIds: string[] = []) { queueMicrotask(() => this.emit({ type: 'chat.connected' })); }
  emit(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  send(raw: string) {
    if (raw === 'ping') return;
    const command = JSON.parse(raw); this.commands.push(command);
    if (command.operation === 'history') {
      // A live message arriving during catch-up must not skip missing history.
      this.emit({ type: 'chat.message', message: message(3) });
      this.emit({ type: 'chat.result', requestId: command.requestId, result: { messages: this.history.filter(m => m.sequence > command.after), hasMore: false, nextCursor: this.history.at(-1)?.sequence ?? command.after, retentionHours: 24, removedIds: this.removedIds, retainedFrom: 1 } });
    } else if (command.operation === 'send') {
      const sent = { ...message(4), body: command.body };
      this.emit({ type: 'chat.message', message: sent });
      this.emit({ type: 'chat.result', requestId: command.requestId, result: { message: sent, duplicate: false } });
    }
  }
  close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code }); }
}

void test('block visibility removes cached messages by trusted sender and permits unblock/backend attribution', async () => {
  let socket!: FakeSocket;
  const request: GameServiceRequest = async <T>() => ({ url:'wss://realtime.inkwell.ing/connect',playerId:'p_2',channel:'game',expiresAt:Date.now()+300000 }) as T;
  const connection = await createChat(request,() => { socket=new FakeSocket([message(1)]); return socket as unknown as WebSocket; }).connect();
  try {
    assert.equal(connection.messages.length,2);
    socket.emit({type:'chat.visibility',channel:'game',senderIds:['p_1'],blockedSenderIds:['p_1']});
    assert.equal(connection.messages.length,0);
    socket.emit({type:'chat.message',message:{...message(4),author:{id:'p_2',displayName:'Spoofed'}}});
    assert.equal(connection.messages.length,0);
    socket.emit({type:'chat.message',message:{...message(5),senderId:'backend',author:{id:'p_1',displayName:'Creator character'}}});
    assert.equal(connection.messages.length,1);
    socket.emit({type:'chat.visibility',channel:'game',senderIds:['p_1'],blockedSenderIds:[]});
    socket.emit({type:'chat.message',message:message(6)});
    assert.deepEqual(connection.messages.map(m=>m.sequence),[5,6]);
  } finally { connection.close(); }
});

void test('new block visibility during catch-up cannot be undone by stale history or buffered messages', async () => {
  class RacingSocket extends FakeSocket {
    override send(raw:string) {
      const command=JSON.parse(raw);
      if(command.operation!=='history') return super.send(raw);
      this.emit({type:'chat.visibility',channel:'game',senderIds:['p_1'],blockedSenderIds:['p_1']});
      this.emit({type:'chat.message',message:message(3)});
      this.emit({type:'chat.result',requestId:command.requestId,result:{messages:[message(1)],nextCursor:1,hasMore:false,retentionHours:24,removedIds:[],retainedFrom:1,senderIds:['p_1'],blockedSenderIds:[]}});
    }
  }
  const request: GameServiceRequest = async <T>() => ({url:'wss://realtime.inkwell.ing/connect',playerId:'p_2',channel:'game',expiresAt:Date.now()+300000}) as T;
  const connection=await createChat(request,()=>new RacingSocket([]) as unknown as WebSocket).connect();
  try { assert.deepEqual(connection.messages,[]); } finally { connection.close(); }
});

void test('chat connection catches up, deduplicates live messages, sends and cleans up', async () => {
  let socket!: FakeSocket;
  const calls: Record<string, unknown>[] = [];
  const request: GameServiceRequest = async <T>(_service: string, input: Record<string, unknown>) => {
    calls.push(input);
    return { url: 'wss://realtime.inkwell.ing/connect?token=scoped', playerId: 'p_1', channel: 'game', expiresAt: Date.now() + 300000 } as T;
  };
  const received: number[] = [];
  const client = createChat(request, () => { socket = new FakeSocket([message(1), message(2)]); return socket as unknown as WebSocket; });
  const connection = await client.connect('game', { onMessage: msg => received.push(msg.sequence) });
  try {
    assert.equal(connection.state, 'connected');
    assert.equal(connection.playerId, 'p_1');
    assert.deepEqual(received, [1, 2, 3]);
    socket.emit({ type: 'chat.message', message: message(3) });
    assert.deepEqual(received, [1, 2, 3]);
    const sent = await connection.send('hello again', { id: 'stable-retry-id', author: { displayName: 'Dragon' }, recipients: ['p_2'] });
    assert.equal(sent.message.body, 'hello again');
    assert.equal(socket.commands.at(-1)!.id, 'stable-retry-id');
    assert.deepEqual(socket.commands.at(-1)!.recipients, ['p_2']);
    socket.emit({ type: 'chat.removed', channel: 'game', id: 'message-2' });
    assert.deepEqual(connection.messages.map(m => m.sequence), [1, 3, 4]);
    assert.deepEqual(calls, [{ operation: 'connect', channel: 'game' }]);
    assert.equal('dm' in client, false);
  } finally { connection.close(); }
  assert.equal(socket.readyState, 3);
  assert.equal(connection.state, 'closed');
  await assert.rejects(connection.send('closed'), /not connected/);
});

void test('reconnect obtains fresh access and catches up from the last sequence', async () => {
  const sockets: FakeSocket[] = [];
  let tickets = 0;
  const request: GameServiceRequest = async <T>() => ({ url: `wss://realtime.inkwell.ing/connect?token=${++tickets}`, playerId: 'p_1', channel: 'game', expiresAt: Date.now() + 300000 }) as T;
  const received: number[] = [];
  const client = createChat(request, () => { const socket = new FakeSocket(sockets.length ? [message(4), message(5)] : [message(1), message(2)], sockets.length ? ['message-2'] : []); sockets.push(socket); return socket as unknown as WebSocket; });
  const connection = await client.connect('game', { onMessage: msg => received.push(msg.sequence) });
  try {
    const resumed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Reconnect timed out')), 4000);
      const remove = connection.onState(state => { if (state === 'connected') { clearTimeout(timer); remove(); resolve(); } });
    });
    sockets[0].close(4001);
    await resumed;
    assert.equal(tickets, 2);
    assert.equal(sockets[1].commands[0].after, 3);
    assert.deepEqual(received, [1, 2, 3, 4, 5]);
    assert.deepEqual(connection.messages.map(m => m.sequence), [1, 3, 4, 5]);
  } finally { connection.close(); }
});

void test('backend chat exposes scoped management and targeted sends without account messaging', async () => {
  const calls: [string, Record<string, unknown>][] = [];
  const request: GameServiceRequest = async <T>(service: string, command: Record<string, unknown>) => { calls.push([service, command]); return {} as T; };
  const chat = createServerChat(request);
  await chat.define('match:1', { serverWritesOnly: true });
  await chat.channel('match:1').send('hello', { id: 'retry-message', author: { displayName: 'NPC' }, recipients: ['p_2'] });
  await chat.channel('match:1').remove('message-id');
  await chat.channel('match:1').history(42);
  assert.equal(calls.every(([service]) => service === 'chat'), true);
  assert.equal(calls[1][1].channel, 'match:1');
  assert.deepEqual(calls[1][1].recipients, ['p_2']);
  assert.equal(calls[3][1].after, 42);
  assert.throws(() => chat.channel('../user:someone'), /Invalid/);
  assert.equal('dm' in chat, false);
});

void test('identity change during renewal clears private history and fails closed', async () => {
  let ticketCount = 0;
  let socket!: FakeSocket;
  const request: GameServiceRequest = async <T>() => ({ url: 'wss://realtime.inkwell.ing/connect', playerId: ++ticketCount === 1 ? 'alice' : 'bob', channel: 'game', expiresAt: Date.now() + 300000 }) as T;
  const notices: string[] = [];
  const connection = await createChat(request, () => { socket = new FakeSocket([{ ...message(1), body: 'Alice private', recipients: ['alice'] }]); return socket as unknown as WebSocket; }).connect('game', { onModeration: event => notices.push(event.type) });
  try {
    assert.ok(connection.messages.some(message => message.body === 'Alice private'));
    const closed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Identity change did not close chat')), 4000);
      connection.onState(state => { if (state === 'closed') { clearTimeout(timer); resolve(); } });
    });
    socket.close(4001);
    await closed;
    assert.equal(connection.playerId, '');
    assert.deepEqual(connection.messages, []);
    assert.deepEqual(notices, ['chat.cleared']);
  } finally { connection.close(); }
});
