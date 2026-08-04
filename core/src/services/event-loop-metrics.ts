import { monitorEventLoopDelay } from "node:perf_hooks";

// A single, process-lifetime histogram (Node's own recommended pattern — see the perf_hooks
// docs) rather than one created per /internal/metrics request: the whole point is measuring
// delay accumulated *between* samples, which requires one continuously-running histogram, not a
// fresh one each time someone asks. 10ms resolution is fine-grained enough to see real
// degradation under load (the batch window itself is 300ms by default) without generating
// excessive sampling overhead. See docs/load-testing.md.
const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();

export interface EventLoopLagSnapshot {
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

const nsToMs = (ns: number): number => ns / 1_000_000;

/** Snapshots the histogram's current state. Does NOT reset it — callers wanting a fresh window
 * should call `resetEventLoopLagHistogram()` right after reading, same as Node's own documented
 * usage pattern. */
export function getEventLoopLagSnapshot(): EventLoopLagSnapshot {
  return {
    meanMs: Number.isNaN(histogram.mean) ? 0 : nsToMs(histogram.mean),
    p50Ms: nsToMs(histogram.percentile(50)),
    p95Ms: nsToMs(histogram.percentile(95)),
    p99Ms: nsToMs(histogram.percentile(99)),
    maxMs: nsToMs(histogram.max),
  };
}

export function resetEventLoopLagHistogram(): void {
  histogram.reset();
}
