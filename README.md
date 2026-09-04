# Inkwell SDK

The tiny, optional SDK for browser games hosted on [Inkwell](https://inkwell.ing). Your game remains a normal static web app: relative asset URLs, `fetch`, Three.js loaders, and PixiJS Assets all work without this package.

Install the public package from npm:

```bash
npm install @silicon-jungle/inkwell-sdk
```

```ts
import { Inkwell } from "@silicon-jungle/inkwell-sdk";

await startGame();
Inkwell.ready();

const player = await Inkwell.player.get();
// { displayName: 'james', avatarUrl: '...', isGuest: false }

const online = await Inkwell.presence.get();
// { total, guestCount, players, friends }

const stopMonitoring = Inkwell.performance.start();

// When the player reaches your definition of completion:
Inkwell.session.complete();
stopMonitoring();
```

## Modular imports

```ts
import { ready } from "@silicon-jungle/inkwell-sdk/core";
import { complete } from "@silicon-jungle/inkwell-sdk/session";
import { track } from "@silicon-jungle/inkwell-sdk/analytics";
import { trackedFetch, defaultTracker } from "@silicon-jungle/inkwell-sdk/assets";
import { get as getPlayer } from "@silicon-jungle/inkwell-sdk/player";
import { get as getPresence } from "@silicon-jungle/inkwell-sdk/presence";
import { start as startPerformanceMonitoring } from "@silicon-jungle/inkwell-sdk/performance";
import { connectBackend, requestBackend } from "@silicon-jungle/inkwell-sdk/backend";
```

## Creator backends

Use one logical on-demand backend for a room, small persistent world,
matchmaking, occasional API work, or a combination. Realtime connections prefer
WebTransport reliable streams plus unreliable QUIC datagrams and fall back to
WebSocket when necessary.

```ts
const connection = await Inkwell.backend.connect();
await connection.sendReliable("chat.send", { text: "hello" });
connection.sendUnreliable("player.input", { x: 1, y: 0 });

const response = await Inkwell.backend.request("/inventory/save", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ slots }),
});
```

Server code exports `defineBackend(...)` from the `/server` entry point. Its
`fetch` handler receives the authenticated, bounded player identity as the third
argument. Browser request/response bodies are capped at 1 MiB.

## Assets and loading bars

Keep using normal relative URLs such as `./assets/level.glb`. Inkwell serves them from the game build's immutable isolated origin. Existing engine loaders are the best default.

For a byte-aware loading bar, use `trackedFetch`; for Three.js, PixiJS, or another loader, wrap its promise with `trackPromise` or report progress through an `AssetTracker`.

```ts
const unsubscribe = defaultTracker.subscribe(({ ratio }) => {
  loadingBar.value = ratio ?? 0;
});

const response = await trackedFetch("./assets/level.glb");
const level = await response.arrayBuffer();
unsubscribe();
```

## Analytics

`ready()` and `session.complete()` power Inkwell's default creator-only play analytics. Small custom events are opt-in:

```ts
Inkwell.analytics.track("level.complete", { level: 3, score: 1200 });
```

The SDK sends messages only to the trusted Inkwell player parent. It does not collect raw IP addresses, advertising identifiers, or cross-site tracking data.

## Performance monitoring

Performance monitoring is opt-in. `Inkwell.performance.start()` sends one bounded aggregate sample every 30 seconds: FPS, p95/max frame time, long-task count and duration, visibility, and JS heap usage where the browser exposes it. It does not send raw traces, resource URLs, hardware details, or fingerprints.

## Leaderboards

Optional module (requires the platform game-services release):

```ts
import { leaderboards } from '@silicon-jungle/inkwell-sdk/leaderboards'

const board = leaderboards.board('highscores')
await board.submit({ score: 12500, details: [3], method: 'keepBest' })
const top = await board.list({ scope: 'global', start: 1, limit: 20 })
const friends = await board.list({ scope: 'friends' })
const nearby = await board.aroundMe({ before: 5, after: 5 })
const mine = await board.getMyEntry()
```

`Inkwell.leaderboards` exposes the same browser API. Create boards in Manage
games, through the creator API, or the hosted backend context's
`leaderboards.define()`. Backend boards expose `submitFor(username, submission)`,
`queryFor(username, query)`, `update(definition)`, `reset()`,
`deleteEntry(username)`, and `delete()`.
`createRuntimeServices()` also supplies backend leaderboards outside the hosted
backend context. Runtime credentials must stay on the server.

Scores and up to 64 optional detail values are signed int32. Boards support
ascending/descending ordering, numeric/seconds/milliseconds display, backend-only
writes, and friends-only client reads. There are no replay attachments.
Queries return `{ board, total, entries }`; entries expose username, avatar, rank,
score, details and update time, never private account data. Signed-in accounts
are required for score persistence. Submissions are limited to 10 per
player/game per fixed ten-minute window. Send results, not per-frame scores.

## Achievements and stats

These optional modules require the game-services platform release.

```ts
import { achievements } from '@silicon-jungle/inkwell-sdk/achievements'
import { stats } from '@silicon-jungle/inkwell-sdk/stats'

await achievements.unlock('first_win')
const other = await achievements.get('explorer', { game: 'another-game' })
if (other?.unlocked) await achievements.unlock('well_travelled')
const requestId = crypto.randomUUID() // reuse only when retrying this update
await stats.increment('coins', 1, { requestId })
await stats.updateAverage('points_per_second', 120, 30)
```

`Inkwell.achievements` and `Inkwell.stats` expose the same APIs. Backend contexts
and `createRuntimeServices()` additionally provide definition management,
`achievements.unlockFor(username, name)` and `stats.forPlayer(username)`.
Cross-game achievement reads require public, published games and never permit
cross-game writes. Hidden achievement details stay hidden until unlocked.

Stats support integer/fractional/average values, bounds, increment-only writes,
maximum changes, backend-only authority, and aggregated totals/daily history.
Linked achievements unlock in the same transaction as a successful stat update.
Repeated unlocks preserve the original date; repeated stat request IDs cannot
double-count. Await writes for persistence (or an explicit queued receipt when
offline support is enabled). `achievements.clear(name)` and `stats.reset({ achievements: true })`
support testing, respecting backend-only write restrictions.

### Optional offline progress

```ts
import { offline } from '@silicon-jungle/inkwell-sdk/offline'
await offline.enable() // Online, signed-in session required first.
const result = await stats.increment('coins', 1)
if (result.queued) showPendingSave() // On this device, not yet server-confirmed.
const { pending, failures } = await offline.status()
await offline.flush() // Reconnect also triggers automatic retries.
```

`Inkwell.offline` exposes the same controls. The platform parent stores queued
stat writes and achievement unlocks in IndexedDB, partitioned by game/player,
so a new immutable build origin does not lose them. Enable again each play
session. Own-player reads may use cached responses tagged `offline`, `cachedAt`
and `pendingWrites`; they do not optimistically include pending mutations.
Cross-game/other-player reads, clears, resets and backend operations are never
queued. Resets invalidate older pending writes. Failed/expired saves appear in
`status().failures`; no synthetic unlock is reported before server acceptance.
Limits: 1,000 writes / 512,000 serialized characters per game/player, seven-day
expiry, 50 recent failure records. Clearing browser data removes pending saves.
`disable()` stops queueing/retries without deleting pending data. This module
does not cache game assets or make a fresh offline login possible.

### Progress notifications
Achievement progress can also be shown without persisting it:

```ts
await achievements.indicateProgress('collector', 3, 10)
const unsubscribe = achievements.onNotification(notice => {
  // kind is 'unlocked' or 'progress'; this event comes from the current host.
  updateGameUI(notice)
})
```

Progress display does not change a stat or unlock an achievement. Saved awards
appear in the platform player header, not over the game. Backend code can use
`context.achievements.indicateProgressFor(username, name, current, max)`.
Notifications are best-effort; query saved state after reconnecting. Call
`unsubscribe()` when your UI is disposed.

## Game chat (optional module)


```ts
import { chat } from '@silicon-jungle/inkwell-sdk/chat'

const channel = await chat.connect('game', {
  onMessage: message => renderMessage(message),
  onModeration: event => removeOrClearMessages(event),
})
await channel.send('Hello!', { author: { displayName: 'My character' } })
await channel.send('Party ready.', { recipients: [otherPlayerId] })
channel.close()
```

The SDK renews channel access and reconnects with history catch-up automatically.
Use a stable `id` in send options when retrying a failed send. Displayed authors
are game-controlled, not verified human identities. Routing IDs come from
`channel.playerId` or backend `connection.identity.playerId`; directed messages
stay within this game and are also readable by its backend. Named channels are
joinable by players of the game, not private rooms merely because their names
are hard to guess. This API provides no platform DMs or account messaging.

Hosted backend `context.chat` supports `list`, `define`, and `channel(name)` with
`send`, `history`, `remove`, `clear`, and `delete`. To subscribe from a backend,
use `createRuntimeServices().chat.connect(name)` from the `/storage` module.

Per game: 128 channels, 1,000 retained messages/removal markers, 24-hour history,
500 concurrent sockets. Per player/backend: four sockets. Messages allow 2,000
characters and 32 recipients. Player sends are limited to 20/minute across
channels; backend sends to 240/minute. History pages have at most 100 messages.
Removed messages cannot be resurrected by retrying the same ID while their
removal marker is retained. See [game chat documentation](https://inkwell.ing/docs/chat).

## Development

```bash
npm install
npm run check
npm test
```

MIT licensed.

## Engine exports and startup

A standalone browser bundle is shipped at `dist/inkwell.browser.js` (also exported as `/browser`). Copy it into your export and load it before the game loader to expose `window.Inkwell`. The Godot and Unity packages do this during export. Loading the bundle does not mark the game ready.

```ts
Inkwell.loading.progress(0.4); // null for indeterminate progress
await startGame();
Inkwell.ready(); // after the game becomes interactive
// On a startup failure: Inkwell.loading.fail("Could not load the first level.");
```

`ready()` and failure are terminal for this page load; later progress is ignored. Retry reloads the game. Only send player-readable failure text, up to 500 characters. The platform applies the timeout declared in the project config. Legacy exports can explicitly choose `startup.mode: "compatible"` to retain their own loading UI.

`defineGameConfig` from `/config` also accepts `game`, `client.entrypoint`, `client.engine`, `client.capabilities.threads`, and `client.startup`. Engine exports keep their own HTML shell. Thread support is opt-in and requires a compatible browser.

Persistent game data remains developer-defined: use the existing backend `fetch` handler, trusted handler identity, database, and object storage. The engine examples demonstrate this without introducing a platform save format or a separate saves API.
