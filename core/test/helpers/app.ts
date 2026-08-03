import { buildServer } from "../../src/server";

export function makeApp() {
  return buildServer({ logger: false, startBackgroundJobs: false });
}
