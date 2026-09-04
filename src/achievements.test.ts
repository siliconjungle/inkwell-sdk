import assert from "node:assert/strict";
import test from "node:test";
import { createAchievements, createServerAchievements } from "./achievements.js";
import { createStats, createServerStats } from "./stats.js";
import type { GameServiceRequest } from "./game-services.js";

test("achievements allow cross-game reads, while unlock remains current-game scoped", async () => {
  const calls: Record<string, unknown>[] = [];
  const request: GameServiceRequest = async <T>(
    _service: string,
    body: Record<string, unknown>,
  ) => {
    calls.push(body);
    return { achievements: [{ name: "winner", unlocked: true }] } as T;
  };
  const achievements = createAchievements(request);
  assert.equal((await achievements.get("winner", { game: "other-game" }))?.unlocked, true);
  await achievements.unlock("visitor");
  await createServerAchievements(request).unlockFor("jungle", "winner");
  assert.equal(calls[0].game, "other-game");
  assert.equal(calls[1].game, undefined);
  assert.equal(calls[2].username, "jungle");
});
test("stat SDK sends stable retry IDs and server player context", async () => {
  const calls: Record<string, unknown>[] = [];
  const request: GameServiceRequest = async <T>(
    _service: string,
    body: Record<string, unknown>,
  ) => {
    calls.push(body);
    return {} as T;
  };
  const stats = createStats(request);
  const requestId = crypto.randomUUID();
  await stats.increment("coins", 3, { requestId });
  await stats.increment("coins", 3, { requestId });
  await createServerStats(request).forPlayer("jungle").updateAverage("speed", 100, 10);
  assert.equal(calls[0].requestId, calls[1].requestId);
  assert.equal(calls[2].username, "jungle");
  assert.equal(calls[2].seconds, 10);
  assert.throws(() => stats.updateAverage("speed", 10, 0));
  assert.throws(() => stats.set("coins", Infinity));
});
