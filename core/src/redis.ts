import Redis from "ioredis";
import { config } from "./config";

export const redis = new Redis(config.redisUrl, {
  // Fail fast in tests/scripts rather than retrying forever against a down Redis.
  maxRetriesPerRequest: 3,
});
