import type { LatLng } from "./haversine";

export interface MlEtaPrediction {
  etaSeconds: number;
  distanceMeters: number;
  modelVersion: string;
}

export type MlEtaFailureReason = "unreachable" | "timeout" | "error_status" | "malformed_response";

export type MlEtaResult =
  | { ok: true; prediction: MlEtaPrediction }
  | { ok: false; reason: MlEtaFailureReason; detail: string };

export interface MlEtaClientConfig {
  mlServiceUrl: string;
  timeoutMs: number;
}

/**
 * Calls ml-service's POST /predict-eta (docs/eta-model.md) with a hard timeout, returning a
 * discriminated result rather than throwing — every caller (eta.service.ts) needs to distinguish
 * "unreachable" (connection refused/DNS failure), "timeout" (took longer than `timeoutMs`),
 * "error_status" (a non-2xx HTTP response), and "malformed_response" (200 but the body doesn't
 * look like a real prediction) as three-plus genuinely different failure modes, each requiring
 * its own test (see docs/eta-integration.md and test/eta-ml-fallback.test.ts).
 */
export async function fetchMlEta(
  pickup: LatLng,
  dropoff: LatLng,
  timestamp: Date,
  cfg: MlEtaClientConfig,
): Promise<MlEtaResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${cfg.mlServiceUrl}/predict-eta`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pickup, dropoff, timestamp: timestamp.toISOString() }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, reason: "timeout", detail: `no response within ${cfg.timeoutMs}ms` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "unreachable", detail: message };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    return { ok: false, reason: "error_status", detail: `ml-service responded ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "malformed_response", detail: "response body was not valid JSON" };
  }

  const prediction = parsePrediction(body);
  if (!prediction) {
    return {
      ok: false,
      reason: "malformed_response",
      detail: `unexpected response shape: ${JSON.stringify(body)}`,
    };
  }

  return { ok: true, prediction };
}

function parsePrediction(body: unknown): MlEtaPrediction | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;

  const etaSeconds = b.predicted_duration_seconds;
  const distanceMeters = b.distance_meters;
  const modelVersion = b.model_version;

  if (typeof etaSeconds !== "number" || !Number.isFinite(etaSeconds) || etaSeconds < 0) return null;
  if (
    typeof distanceMeters !== "number" ||
    !Number.isFinite(distanceMeters) ||
    distanceMeters < 0
  ) {
    return null;
  }
  if (typeof modelVersion !== "string" || modelVersion.length === 0) return null;

  return { etaSeconds, distanceMeters, modelVersion };
}
