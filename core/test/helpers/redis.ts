import { redis } from "../../src/redis";

export async function resetRedis(): Promise<void> {
  await redis.flushdb();
}
