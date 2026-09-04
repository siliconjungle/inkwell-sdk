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

test('find, dynamic creation and entry counts retain browser/backend boundaries', async () => {
  const calls: Record<string, unknown>[] = [];
  const request: GameServiceRequest = async <T>(_service: string, input: Record<string, unknown>) => {
    calls.push(input);
    if (input.name === 'missing') throw new GameServiceError('Not found', 404);
    if (input.name === 'forbidden') throw new GameServiceError('Forbidden', 403);
    return { total: 42, board: { name: input.name } } as T;
  };
  const client = createLeaderboards(request);
  assert.equal(await client.find('missing'), null);
  await assert.rejects(client.find('forbidden'), /Forbidden/);
  assert.equal((await client.find('score'))?.name, 'score');
  const board = await client.findOrCreate({ name: 'daily:2026-09-04', sort: 'ascending', display: 'milliseconds' });
  assert.equal(board.name, 'daily:2026-09-04');
  assert.equal(await board.getEntryCount(), 42);
  assert.equal('delete' in board, false);
  const server = createServerLeaderboards(request);
  const managed = await server.findOrCreate({ name: 'season', serverWritesOnly: true });
  await managed.deleteEntry('jungle');
  assert.ok((await server.find('season'))?.delete);
  assert.ok(calls.some(input => input.operation === 'count'));
  assert.deepEqual(calls.find(input => input.operation === 'findOrCreate'), {
    operation: 'findOrCreate', name: 'daily:2026-09-04', definition: { name: 'daily:2026-09-04', sort: 'ascending', display: 'milliseconds' },
  });
});
