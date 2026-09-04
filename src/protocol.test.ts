import assert from 'node:assert/strict';
import test from 'node:test';
import { parentOrigin } from './protocol.js';

void test('parent origin survives frame reload without broadening trusted origins', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const storage = new Map<string, string>();
  const location: { ancestorOrigins?: string[] } = {};
  const document = { referrer: 'https://inkwell.ing/games/example/play' };
  const sessionStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location, sessionStorage } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  try {
    assert.equal(parentOrigin(), 'https://inkwell.ing');
    document.referrer = 'https://build-game.inkwellgame.com/index.html';
    assert.equal(parentOrigin(), 'https://inkwell.ing', 'Firefox-style reload retains a known host, not the game origin');
    location.ancestorOrigins = ['https://www.inkwell.ing'];
    assert.equal(parentOrigin(), 'https://www.inkwell.ing', 'browser-reported parent wins over game referrer and cache');
    location.ancestorOrigins = ['https://untrusted.example'];
    document.referrer = 'https://inkwell.ing/';
    assert.equal(parentOrigin(), null, 'a foreign actual parent cannot use a trusted referrer/cache');
    delete location.ancestorOrigins;
    document.referrer = '';
    storage.set('inkwell:parent-origin:v1', 'https://inkwell.ing.attacker.example');
    assert.equal(parentOrigin(), null);
    storage.set('inkwell:parent-origin:v1', 'javascript:alert(1)');
    assert.equal(parentOrigin(), null);
    document.referrer = 'http://localhost:3000/games/example/play';
    assert.equal(parentOrigin(), 'http://localhost:3000');
    sessionStorage.setItem = () => { throw new Error('storage denied'); };
    assert.equal(parentOrigin(), 'http://localhost:3000', 'denied storage does not break an observed valid host');
    document.referrer = '';
    sessionStorage.getItem = () => { throw new Error('storage denied'); };
    assert.equal(parentOrigin(), null);
    location.ancestorOrigins = ['https://inkwell.ing'];
    assert.equal(parentOrigin(), 'https://inkwell.ing', 'browser ancestry works even with storage/referrer unavailable');
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});
