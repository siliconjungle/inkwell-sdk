import assert from "node:assert/strict";
import test from "node:test";

import { AssetTracker } from "./assets.js";
import { track } from "./analytics.js";
import { summariseFrameTimes } from "./performance.js";
import { normalisePresence } from "./presence.js";
import { emit, parentOrigin } from "./protocol.js";

test("asset tracker aggregates known byte progress", () => {
  const tracker = new AssetTracker();
  tracker.update("a", { loadedBytes: 5, totalBytes: 10 });
  tracker.update("b", { loadedBytes: 10, totalBytes: 10, completed: true });
  assert.equal(tracker.snapshot().ratio, 0.75);
  assert.equal(tracker.snapshot().loadedAssets, 1);
});

test("analytics rejects unsafe event names", () => {
  assert.throws(() => track("not allowed spaces"));
});

test("performance monitor summarises frame timing without raw traces", () => {
  const summary = summariseFrameTimes([16, 16, 17, 40]);
  assert.equal(summary.fps, 44.9);
  assert.equal(summary.frameTimeP95Ms, 40);
  assert.equal(summary.frameTimeMaxMs, 40);
});

test("presence exposes only valid, bounded public player and friend profiles", () => {
  const presence = normalisePresence({
    count: 3.9,
    guestCount: 1,
    players: [
      {
        playerId: "session_1",
        username: "maya",
        displayName: "Maya",
        avatarUrl: null,
        isGuest: false,
      },
      { playerId: 42, displayName: "invalid" },
    ],
    friends: [
      { username: "maya", displayName: "Maya", avatarUrl: null },
      { username: null, displayName: "invalid", avatarUrl: null },
    ],
  });
  assert.equal(presence.total, 3);
  assert.equal(presence.players.length, 1);
  assert.deepEqual(presence.friends, [
    { username: "maya", displayName: "Maya", avatarUrl: null },
  ]);
});

test("protocol fails closed outside a trusted Inkwell embed", () => {
  assert.equal(parentOrigin(), null);
  assert.equal(emit("ready"), false);
});
