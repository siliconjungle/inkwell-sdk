import { emit } from "./protocol.js";

export type PerformanceSnapshot = {
  fps: number | null;
  frameTimeP95Ms: number | null;
  frameTimeMaxMs: number | null;
  longTaskCount: number;
  longTaskDurationMs: number;
  visibility: "visible" | "hidden";
  memoryUsedMb: number | null;
};

export type PerformanceMonitorOptions = { reportIntervalMs?: number };

let stopCurrent: (() => void) | null = null;
let reportCurrent: (() => PerformanceSnapshot) | null = null;
let snapshotCurrent: (() => PerformanceSnapshot) | null = null;

export function summariseFrameTimes(frameTimes: readonly number[]) {
  if (!frameTimes.length) return { fps: null, frameTimeP95Ms: null, frameTimeMaxMs: null };
  const sorted = [...frameTimes].sort((left, right) => left - right);
  const average = frameTimes.reduce((sum, value) => sum + value, 0) / frameTimes.length;
  return {
    fps: Math.round((1000 / average) * 10) / 10,
    frameTimeP95Ms: Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1]! * 10) / 10,
    frameTimeMaxMs: Math.round(sorted[sorted.length - 1]! * 10) / 10,
  };
}

/** Starts bounded, aggregate-only browser performance sampling. */
export function start(options: PerformanceMonitorOptions = {}) {
  stopCurrent?.();
  if (typeof window === "undefined") return () => undefined;
  const intervalMs = Math.max(10_000, options.reportIntervalMs ?? 30_000);
  let frameTimes: number[] = [];
  let previousFrame: number | null = null;
  let animationFrame = 0;
  let longTaskCount = 0;
  let longTaskDurationMs = 0;

  const onFrame = (timestamp: number) => {
    if (previousFrame != null && document.visibilityState === "visible") {
      frameTimes.push(Math.min(1_000, timestamp - previousFrame));
      if (frameTimes.length > 3_600) frameTimes.shift();
    }
    previousFrame = timestamp;
    animationFrame = window.requestAnimationFrame(onFrame);
  };
  animationFrame = window.requestAnimationFrame(onFrame);

  let observer: PerformanceObserver | null = null;
  if (
    typeof PerformanceObserver !== "undefined" &&
    PerformanceObserver.supportedEntryTypes.includes("longtask")
  ) {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTaskCount += 1;
        longTaskDurationMs += entry.duration;
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
  }

  const snapshot = (): PerformanceSnapshot => {
    const browserPerformance = globalThis.performance as Performance & {
      memory?: { usedJSHeapSize?: number };
    };
    const heapBytes = browserPerformance.memory?.usedJSHeapSize;
    return {
      ...summariseFrameTimes(frameTimes),
      longTaskCount,
      longTaskDurationMs: Math.round(longTaskDurationMs * 10) / 10,
      visibility: document.visibilityState === "visible" ? "visible" : "hidden",
      memoryUsedMb:
        typeof heapBytes === "number" ? Math.round((heapBytes / 1024 / 1024) * 10) / 10 : null,
    };
  };
  const report = () => {
    const sample = snapshot();
    emit("performance.sample", sample);
    frameTimes = [];
    longTaskCount = 0;
    longTaskDurationMs = 0;
    return sample;
  };
  const timer = window.setInterval(report, intervalMs);
  const stop = () => {
    window.clearInterval(timer);
    window.cancelAnimationFrame(animationFrame);
    observer?.disconnect();
    if (frameTimes.length || longTaskCount) report();
    if (stopCurrent === stop) {
      stopCurrent = null;
      reportCurrent = null;
      snapshotCurrent = null;
    }
  };
  stopCurrent = stop;
  reportCurrent = report;
  snapshotCurrent = snapshot;
  return stop;
}

export function stop() {
  stopCurrent?.();
}
export function report() {
  return reportCurrent?.() ?? null;
}
export function snapshot() {
  return snapshotCurrent?.() ?? null;
}

export const performanceMonitoring = Object.freeze({ start, stop, report, snapshot });
