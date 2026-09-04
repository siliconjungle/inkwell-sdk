import assert from "node:assert/strict";
import test from "node:test";
import { createLeaderboards, createServerLeaderboards } from "./leaderboards.js";
import {
  createGameServiceRequest,
  GameServiceError,
  type GameServiceRequest,
} from "./game-services.js";

test("browser leaderboard requests cannot select a different game", async () => {
  const calls: unknown[] = [];
  const request: GameServiceRequest = async <T>(
    service: string,
    payload: Record<string, unknown>,
  ) => {
    calls.push({ service, payload });
    return { entries: [] } as T;
  };
  const boards = createLeaderboards(request);
  await boards.board("score").submit({ score: 12, details: [1, 2] });
  await boards.board("score").aroundMe();
  assert.equal(await boards.board("score").getMyEntry(), null);
  assert.deepEqual(calls[0], {
    service: "leaderboards",
    payload: { operation: "submit", name: "score", score: 12, details: [1, 2] },
  });
  assert.throws(() => boards.board("../other-game"));
  assert.throws(() => boards.board("x").submit({ score: Infinity }));
  assert.throws(() => boards.board("x").submit({ score: 0, details: Array(65).fill(0) }));
});
test("server adapter sends scoped runtime credential and management operations", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const request = createGameServiceRequest({
    baseUrl: "https://inkwell.ing",
    token: "ink_rt_test",
    fetch: (async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return Response.json({ success: true });
    }) as typeof fetch,
  });
  const boards = createServerLeaderboards(request);
  await boards.define({ name: "fastest", sort: "ascending", display: "milliseconds" });
  await boards.board("fastest").submitFor("jungle", { score: 4000, method: "forceUpdate" });
  await boards.board("fastest").deleteEntry("jungle");
  await boards.board("fastest").reset();
  assert.equal(calls[0].url, "https://inkwell.ing/api/v1/game-services/leaderboards");
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer ink_rt_test");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(JSON.parse(String(calls[1].init.body)).username, "jungle");
  assert.throws(() =>
    createGameServiceRequest({ baseUrl: "http://evil.example", token: "secret" }),
  );
});
test("service errors preserve HTTP status and machine-readable code", async () => {
  const request = createGameServiceRequest({
    baseUrl: "https://inkwell.ing",
    token: "test",
    fetch: (async () =>
      Response.json({ error: "Slow down", code: "rate_limited" }, { status: 429 })) as typeof fetch,
  });
  await assert.rejects(
    request("leaderboards", {}),
    (error: unknown) =>
      error instanceof GameServiceError && error.status === 429 && error.code === "rate_limited",
  );
});
