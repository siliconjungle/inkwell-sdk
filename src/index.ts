import { ready } from "./core.js";
import { session } from "./session.js";
import { analytics } from "./analytics.js";
import { assets } from "./assets.js";
import { player } from "./player.js";
import { presence } from "./presence.js";

export { ready } from "./core.js";
export { complete, session } from "./session.js";
export { analytics, track } from "./analytics.js";
export { AssetTracker, assets, defaultTracker, trackedFetch, trackPromise } from "./assets.js";
export type { AnalyticsProperties } from "./analytics.js";
export type { AggregateAssetProgress, AssetProgress } from "./assets.js";
export { get as getPlayer, player } from "./player.js";
export type { Player } from "./player.js";
export { get as getPresence, presence } from "./presence.js";
export type { Presence, PresentPlayer } from "./presence.js";

export const Inkwell = Object.freeze({
  ready,
  session,
  analytics,
  assets,
  player,
  presence,
});
export default Inkwell;
