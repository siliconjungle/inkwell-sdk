import { emit } from './protocol.js';

export type AnalyticsProperties = Record<string, string | number | boolean | null>;

const EVENT_NAME = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/;

/** Sends a small custom event through the trusted Inkwell player parent. */
export function track(name: string, properties: AnalyticsProperties = {}) {
  if (!EVENT_NAME.test(name)) throw new TypeError('Analytics event names must be 1-64 safe characters.');
  const serialised = JSON.stringify(properties);
  if (serialised.length > 8_192) throw new RangeError('Analytics event properties must be at most 8 KB.');
  emit('analytics.track', { name, properties });
}

export const analytics = Object.freeze({ track });
