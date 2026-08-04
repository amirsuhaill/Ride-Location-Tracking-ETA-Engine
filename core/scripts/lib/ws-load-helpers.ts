import WebSocket from "ws";

// Same San Francisco bounding box used throughout this project (core/scripts/seed.ts,
// core/scripts/lib/trip-simulator.ts) — duplicated here rather than imported, consistent with
// this project's established precedent (Phase 8) of small, independent load/utility scripts each
// owning their own copy rather than coupling to each other.
export const SF_BBOX = {
  minLat: 37.708,
  maxLat: 37.812,
  minLng: -122.514,
  maxLng: -122.386,
};

export function randomInBbox(): { lat: number; lng: number } {
  return {
    lat: SF_BBOX.minLat + Math.random() * (SF_BBOX.maxLat - SF_BBOX.minLat),
    lng: SF_BBOX.minLng + Math.random() * (SF_BBOX.maxLng - SF_BBOX.minLng),
  };
}

/** Small random-walk jitter — not a precise bearing/distance simulation (unnecessary for load
 * purposes), just enough to look like plausible movement between pings while staying in bbox. */
export function jitterPosition(
  lat: number,
  lng: number,
  maxDegreeDelta = 0.001,
): { lat: number; lng: number } {
  const nextLat = lat + (Math.random() * 2 - 1) * maxDegreeDelta;
  const nextLng = lng + (Math.random() * 2 - 1) * maxDegreeDelta;
  return {
    lat: Math.min(SF_BBOX.maxLat, Math.max(SF_BBOX.minLat, nextLat)),
    lng: Math.min(SF_BBOX.maxLng, Math.max(SF_BBOX.minLng, nextLng)),
  };
}

export async function inBatches<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += concurrency) {
    const batch = items.slice(start, start + concurrency);
    const batchResults = await Promise.all(batch.map((item, i) => fn(item, start + i)));
    results.push(...batchResults);
  }
  return results;
}

export async function createDriver(httpUrl: string, index: number): Promise<string> {
  const location = randomInBbox();
  const res = await fetch(`${httpUrl}/drivers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: `Load Driver ${index}`,
      vehicleMake: "Load",
      vehicleModel: "Test",
      vehicleColor: "n/a",
      vehiclePlate: `LOAD${index}-${Date.now()}`,
      status: "online",
      location,
    }),
  });
  if (!res.ok) throw new Error(`create driver ${index} failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { id: string };
  return body.id;
}

export async function createRider(httpUrl: string, index: number): Promise<string> {
  const res = await fetch(`${httpUrl}/riders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Load Rider ${index}` }),
  });
  if (!res.ok) throw new Error(`create rider ${index} failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { id: string };
  return body.id;
}

export function connectDriverSocket(wsUrl: string, driverId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsUrl}/ws/driver?driverId=${driverId}`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

export function connectSubscriberSocket(wsUrl: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsUrl}/ws/subscribe`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** Accumulates samples and reports mean/p50/p95/p99/max — used for both location-broadcast and
 * trip-matching latency so the two are reported in a consistent shape. */
export class LatencyStats {
  private samples: number[] = [];

  record(ms: number): void {
    this.samples.push(ms);
  }

  get count(): number {
    return this.samples.length;
  }

  summary(): {
    count: number;
    meanMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
  } {
    if (this.samples.length === 0) {
      return { count: 0, meanMs: NaN, p50Ms: NaN, p95Ms: NaN, p99Ms: NaN, maxMs: NaN };
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    const pct = (p: number): number => {
      const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
      return sorted[idx] as number;
    };
    const mean = sorted.reduce((sum, n) => sum + n, 0) / sorted.length;
    return {
      count: sorted.length,
      meanMs: mean,
      p50Ms: pct(50),
      p95Ms: pct(95),
      p99Ms: pct(99),
      maxMs: sorted[sorted.length - 1] as number,
    };
  }
}

export function formatLatency(s: ReturnType<LatencyStats["summary"]>): string {
  if (s.count === 0) return "no samples";
  return (
    `n=${s.count} mean=${s.meanMs.toFixed(0)}ms p50=${s.p50Ms.toFixed(0)}ms ` +
    `p95=${s.p95Ms.toFixed(0)}ms p99=${s.p99Ms.toFixed(0)}ms max=${s.maxMs.toFixed(0)}ms`
  );
}
