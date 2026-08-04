/**
 * Phase 12 — head-to-head benchmark: the from-scratch GeohashIndex (src/geo/) vs the real Redis
 * GEO path from Phase 3 (src/repositories/drivers.geo.repository.ts's underlying GEOADD/
 * GEOSEARCH commands), at the same dataset sizes used in Phase 11's load test (100, 1K, 100K).
 * See docs/custom-geo-index.md for the full write-up and captured results.
 *
 * Requires a real, reachable Redis (start one — see infra/docker-compose.yml). Writes to a
 * dedicated key (`benchmark:geo:*`), never the production `drivers:geo` key, and deletes it when
 * done.
 *
 * Usage:
 *   BENCHMARK_REDIS_URL=redis://localhost:6379 npx tsx scripts/benchmark-geo-index.ts
 *   node --expose-gc -r tsx/cjs scripts/benchmark-geo-index.ts   # for a real (GC-forced) memory reading
 */
import Redis from "ioredis";
import { GeohashIndex } from "../src/geo/geohash-index";
import { precisionForRadius } from "../src/geo/geohash";

const REDIS_URL = process.env.BENCHMARK_REDIS_URL ?? "redis://localhost:6379";
const SCALES = [100, 1_000, 100_000];
const QUERY_SAMPLE_SIZE = 100;
// Matches MATCH_SEARCH_RADIUS_METERS' default (docs/matching.md) — this system's actual, real
// query radius, not an arbitrary benchmark number.
const BENCHMARK_RADIUS_METERS = 3000;
const KNN_K = 10;
const MEMORY_SCALE = 100_000;

const SF_BBOX = { minLat: 37.708, maxLat: 37.812, minLng: -122.514, maxLng: -122.386 };

function randomPoint(): { lat: number; lng: number } {
  return {
    lat: SF_BBOX.minLat + Math.random() * (SF_BBOX.maxLat - SF_BBOX.minLat),
    lng: SF_BBOX.minLng + Math.random() * (SF_BBOX.maxLng - SF_BBOX.minLng),
  };
}

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

interface LatencyReport {
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

function report(samplesMs: number[]): LatencyReport {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const pct = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
  return {
    meanMs: sorted.reduce((sum, n) => sum + n, 0) / sorted.length,
    p50Ms: pct(50),
    p95Ms: pct(95),
    p99Ms: pct(99),
  };
}

function fmt(r: LatencyReport): string {
  return `mean=${r.meanMs.toFixed(3)}ms p50=${r.p50Ms.toFixed(3)}ms p95=${r.p95Ms.toFixed(3)}ms p99=${r.p99Ms.toFixed(3)}ms`;
}

async function benchmarkInsertCustom(
  points: Array<{ id: string; lat: number; lng: number }>,
): Promise<{ index: GeohashIndex; totalMs: number; perOpMs: number }> {
  const bucketBits = precisionForRadius(
    BENCHMARK_RADIUS_METERS,
    (SF_BBOX.minLat + SF_BBOX.maxLat) / 2,
  );
  const index = new GeohashIndex({ bucketBits });
  const start = nowMs();
  for (const p of points) index.upsert(p.id, p.lat, p.lng);
  const totalMs = nowMs() - start;
  return { index, totalMs, perOpMs: totalMs / points.length };
}

async function benchmarkInsertRedis(
  redis: Redis,
  key: string,
  points: Array<{ id: string; lat: number; lng: number }>,
): Promise<{ totalMs: number; perOpMs: number }> {
  const start = nowMs();
  for (const p of points) {
    await redis.geoadd(key, p.lng, p.lat, p.id);
  }
  const totalMs = nowMs() - start;
  return { totalMs, perOpMs: totalMs / points.length };
}

function benchmarkRadiusCustom(
  index: GeohashIndex,
  queries: Array<{ lat: number; lng: number }>,
): LatencyReport {
  const samples: number[] = [];
  for (const q of queries) {
    const start = nowMs();
    index.radiusSearch(q, BENCHMARK_RADIUS_METERS, 20);
    samples.push(nowMs() - start);
  }
  return report(samples);
}

async function benchmarkRadiusRedis(
  redis: Redis,
  key: string,
  queries: Array<{ lat: number; lng: number }>,
): Promise<LatencyReport> {
  const samples: number[] = [];
  for (const q of queries) {
    const start = nowMs();
    await redis.geosearch(
      key,
      "FROMLONLAT",
      q.lng,
      q.lat,
      "BYRADIUS",
      BENCHMARK_RADIUS_METERS,
      "m",
      "ASC",
      "COUNT",
      20,
      "WITHCOORD",
      "WITHDIST",
    );
    samples.push(nowMs() - start);
  }
  return report(samples);
}

function benchmarkKnnCustom(
  index: GeohashIndex,
  queries: Array<{ lat: number; lng: number }>,
): LatencyReport {
  const samples: number[] = [];
  for (const q of queries) {
    const start = nowMs();
    index.nearestNeighbors(q, KNN_K);
    samples.push(nowMs() - start);
  }
  return report(samples);
}

/** Redis GEOSEARCH has no native unbounded-KNN mode (BYRADIUS/BYBOX are both bounded shapes) —
 * benchmarked here with the exact same iterative-deepening-radius algorithm as
 * GeohashIndex#nearestNeighbors, so both systems are doing the same algorithm, not two different
 * ones, for a fair comparison. */
async function benchmarkKnnRedis(
  redis: Redis,
  key: string,
  queries: Array<{ lat: number; lng: number }>,
): Promise<LatencyReport> {
  const samples: number[] = [];
  for (const q of queries) {
    const start = nowMs();
    let radius = 200;
    let results: unknown[] = [];
    while (results.length < KNN_K && radius < 200_000) {
      results = (await redis.geosearch(
        key,
        "FROMLONLAT",
        q.lng,
        q.lat,
        "BYRADIUS",
        radius,
        "m",
        "COUNT",
        KNN_K,
      )) as unknown[];
      radius *= 2;
    }
    samples.push(nowMs() - start);
  }
  return report(samples);
}

function bytesToMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

async function measureCustomIndexMemory(
  points: Array<{ id: string; lat: number; lng: number }>,
): Promise<number> {
  const g = global as unknown as { gc?: () => void };
  g.gc?.();
  const before = process.memoryUsage().heapUsed;
  const bucketBits = precisionForRadius(
    BENCHMARK_RADIUS_METERS,
    (SF_BBOX.minLat + SF_BBOX.maxLat) / 2,
  );
  const index = new GeohashIndex({ bucketBits });
  for (const p of points) index.upsert(p.id, p.lat, p.lng);
  g.gc?.();
  const after = process.memoryUsage().heapUsed;
  // Keep a reference so V8 can't garbage-collect the index before the "after" reading above.
  if (index.size() < 0) throw new Error("unreachable");
  return after - before;
}

async function readRedisUsedMemoryBytes(redis: Redis): Promise<number> {
  const info = await redis.info("memory");
  const match = /used_memory:(\d+)/.exec(info);
  if (!match) throw new Error("could not parse used_memory from INFO memory");
  return Number(match[1]);
}

async function main(): Promise<void> {
  const redis = new Redis(REDIS_URL);
  const hasGc = typeof (global as unknown as { gc?: unknown }).gc === "function";
  if (!hasGc) {
    console.log(
      "NOTE: run with `node --expose-gc -r tsx/cjs scripts/benchmark-geo-index.ts` for a " +
        "GC-forced (more accurate) memory reading. Proceeding without it — the memory number " +
        "below may include extra transient garbage.\n",
    );
  }

  for (const scale of SCALES) {
    console.log(`\n=== Scale: ${scale} entities ===`);
    const redisKey = `benchmark:geo:${scale}`;
    await redis.del(redisKey);

    const points = Array.from({ length: scale }, (_, i) => ({ id: `e${i}`, ...randomPoint() }));
    const queries = Array.from({ length: Math.min(QUERY_SAMPLE_SIZE, scale) }, () => randomPoint());

    const customInsert = await benchmarkInsertCustom(points);
    console.log(
      `Insert (custom):  total=${customInsert.totalMs.toFixed(1)}ms  ` +
        `avg=${(customInsert.perOpMs * 1000).toFixed(1)}µs/op`,
    );

    const redisInsert = await benchmarkInsertRedis(redis, redisKey, points);
    console.log(
      `Insert (Redis):   total=${redisInsert.totalMs.toFixed(1)}ms  ` +
        `avg=${(redisInsert.perOpMs * 1000).toFixed(1)}µs/op`,
    );

    const radiusCustom = benchmarkRadiusCustom(customInsert.index, queries);
    console.log(`Radius (custom):  ${fmt(radiusCustom)}`);

    const radiusRedis = await benchmarkRadiusRedis(redis, redisKey, queries);
    console.log(`Radius (Redis):   ${fmt(radiusRedis)}`);

    const knnCustom = benchmarkKnnCustom(customInsert.index, queries);
    console.log(`KNN k=${KNN_K} (custom): ${fmt(knnCustom)}`);

    const knnRedis = await benchmarkKnnRedis(redis, redisKey, queries);
    console.log(`KNN k=${KNN_K} (Redis):  ${fmt(knnRedis)}`);

    // Cross-check both approaches agree on roughly the same candidate set for one query, as a
    // correctness sanity check alongside the pure performance numbers.
    const sampleQuery = queries[0]!;
    const customResultIds = new Set(
      customInsert.index.radiusSearch(sampleQuery, BENCHMARK_RADIUS_METERS, 20).map((r) => r.id),
    );
    const redisRaw = (await redis.geosearch(
      redisKey,
      "FROMLONLAT",
      sampleQuery.lng,
      sampleQuery.lat,
      "BYRADIUS",
      BENCHMARK_RADIUS_METERS,
      "m",
      "ASC",
      "COUNT",
      20,
    )) as string[];
    const redisResultIds = new Set(redisRaw);
    const agree = [...customResultIds].every((id) => redisResultIds.has(id));
    console.log(
      `Correctness cross-check: custom found ${customResultIds.size}, Redis found ` +
        `${redisResultIds.size}, custom results ⊆ Redis results: ${agree}`,
    );

    if (scale === MEMORY_SCALE) {
      // used_memory already reflects the just-inserted 100K entries from the insert benchmark
      // above — read it (with the data present), delete the key, then read again (without it)
      // and take the difference, isolating this key's actual contribution from Redis's baseline.
      const usedMemoryWithData = await readRedisUsedMemoryBytes(redis);
      await redis.del(redisKey);
      const usedMemoryWithoutData = await readRedisUsedMemoryBytes(redis);
      const redisMemBytes = usedMemoryWithData - usedMemoryWithoutData;

      const customMemBytes = await measureCustomIndexMemory(points);

      console.log(`\n--- Memory footprint at ${scale.toLocaleString("en-US")} entities ---`);
      console.log(`Custom GeohashIndex: ~${bytesToMb(customMemBytes)}MB (heapUsed delta)`);
      console.log(
        `Redis (drivers:geo-equivalent key): ~${bytesToMb(redisMemBytes)}MB (used_memory delta)`,
      );
    }

    await redis.del(redisKey);
  }

  await redis.quit();
}

main().catch((err: unknown) => {
  console.error("Benchmark failed:", err);
  process.exitCode = 1;
});
