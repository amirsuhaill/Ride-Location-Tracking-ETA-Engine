import type { TripEta } from "../api/types";

const SOURCE_LABEL: Record<string, string> = {
  heuristic: "heuristic",
  heuristic_osrm: "heuristic (OSRM)",
  ml: "ML",
  ml_fallback: "ML (fallback)",
};

/** Surfaces the exact same etaSource/servedFromCache information core's X-ETA-Source/X-ETA-Cache
 * response headers carry (docs/eta-integration.md) — not hidden behind just a plain number. */
export function EtaBadge({ eta }: { eta: TripEta | null }) {
  if (!eta) return null;

  if (eta.etaSeconds === null) {
    return (
      <p className="text-sm text-gray-600" role="status">
        ETA: not available yet ({eta.status})
      </p>
    );
  }

  const minutes = Math.round(eta.etaSeconds / 60);
  const sourceLabel = eta.etaSource ? (SOURCE_LABEL[eta.etaSource] ?? eta.etaSource) : "unknown";

  return (
    <p className="text-sm" role="status">
      <span className="font-semibold">ETA: {minutes} min</span>{" "}
      <span className="text-gray-500">
        ({sourceLabel}
        {eta.servedFromCache !== null && `, ${eta.servedFromCache ? "cached" : "fresh"}`})
      </span>
    </p>
  );
}
