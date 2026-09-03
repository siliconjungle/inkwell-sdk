import { ready } from "./core.js";
import { session } from "./session.js";
import { analytics } from "./analytics.js";
import { assets } from "./assets.js";
import { player } from "./player.js";
import { presence } from "./presence.js";
import { performanceMonitoring } from "./performance.js";
import { backend, connectBackend } from "./backend.js";

export { ready } from "./core.js";
export { complete, session } from "./session.js";
export { analytics, track } from "./analytics.js";
export { AssetTracker, assets, defaultTracker, trackedFetch, trackPromise } from "./assets.js";
export type { AnalyticsProperties } from "./analytics.js";
export type { AggregateAssetProgress, AssetProgress } from "./assets.js";
export { get as getPlayer, player } from "./player.js";
export type { Player } from "./player.js";
export { get as getPresence, presence } from "./presence.js";
export type { Presence, PresentFriend, PresentPlayer } from "./presence.js";
export {
  performanceMonitoring,
  report as reportPerformance,
  snapshot as performanceSnapshot,
  start as startPerformanceMonitoring,
  stop as stopPerformanceMonitoring,
} from "./performance.js";
export type { PerformanceMonitorOptions, PerformanceSnapshot } from "./performance.js";
export {
  backend,
  BackendActionError,
  BackendConnection,
  BackendConnectionError,
  connectBackend,
  WebSocketBackendTransport,
  WebTransportBackendTransport,
} from "./backend.js";
export type {
  AnyBackendProtocol,
  BackendProtocol,
  BackendTransport,
  BackendTransportCapabilities,
  BackendTransportKind,
  UnreliableDelivery,
} from "./backend.js";

export const Inkwell = Object.freeze({
  ready,
  session,
  analytics,
  assets,
  player,
  presence,
  performance: performanceMonitoring,
  backend,
});
export default Inkwell;
