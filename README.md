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
```

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

## Development

```bash
npm install
npm run check
npm test
```

MIT licensed.
