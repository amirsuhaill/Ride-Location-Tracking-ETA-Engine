import type { Trip } from "../api/types";
import { formatCents } from "../format";
import type { TripTrackingState } from "../hooks/useTripTracking";
import { TOUCH_TARGET_CLASS } from "../ui";
import type { SubscriberConnectionState } from "../ws/subscriberSocket";
import { ConnectionStatusBanner } from "./ConnectionStatusBanner";
import { EtaBadge } from "./EtaBadge";
import type { TripEta } from "../api/types";

export interface TripTrackingPanelProps {
  trip: Trip;
  tracking: TripTrackingState;
  connectionState: SubscriberConnectionState;
  eta: TripEta | null;
  onRequestAnother: () => void;
}

const TERMINAL_STATUSES = new Set(["completed", "cancelled"]);

/** Two distinct, honest cancellation messages (docs/matching.md) — never a single generic
 * "no ride found". `null` (before the one-shot GET /trips/:id resolves the specific reason, or
 * in the unlikely case the fetch itself failed) gets its own honest "cancelled, reason unknown
 * yet" message rather than guessing. */
function cancellationMessage(reason: TripTrackingState["cancellationReason"]): string {
  if (reason === "no_drivers_available") return "No drivers are online nearby right now.";
  if (reason === "all_candidates_declined") return "Nearby drivers were asked but none accepted.";
  return "This trip was cancelled.";
}

function StatusLine({ tracking, eta }: { tracking: TripTrackingState; eta: TripEta | null }) {
  switch (tracking.status) {
    case "requested":
      return <p className="text-sm text-gray-700">Looking for a nearby driver…</p>;
    case "matched":
      return (
        <div className="space-y-1">
          <p className="text-sm text-green-700">A driver has been matched and is heading your way.</p>
          <EtaBadge eta={eta} />
        </div>
      );
    case "in_progress":
      return (
        <div className="space-y-1">
          <p className="text-sm text-green-700">Your driver is en route to the dropoff.</p>
          <EtaBadge eta={eta} />
        </div>
      );
    case "completed":
      return <p className="text-sm text-green-700">Trip completed.</p>;
    case "cancelled":
      return (
        <p role="alert" className="text-sm text-red-600">
          {cancellationMessage(tracking.cancellationReason)}
        </p>
      );
    default:
      return null;
  }
}

export function TripTrackingPanel({
  trip,
  tracking,
  connectionState,
  eta,
  onRequestAnother,
}: TripTrackingPanelProps) {
  const fare = trip.fareEstimate;
  const isTerminal = TERMINAL_STATUSES.has(tracking.status);

  return (
    <div>
      <h2 className="text-base font-semibold">
        Trip <span className="font-mono text-sm font-normal text-gray-500">{trip.id.slice(0, 8)}…</span>
      </h2>
      <ConnectionStatusBanner state={connectionState} />

      <div className="mt-2">
        <StatusLine tracking={tracking} eta={eta} />
      </div>

      {fare ? (
        <dl className="mt-3 space-y-1 text-sm">
          <div className="flex justify-between border-t border-gray-200 pt-2 text-base font-semibold">
            <dt>Fare total</dt>
            <dd>{formatCents(fare.totalCents, fare.currency)}</dd>
          </div>
          <div className="flex justify-between text-gray-500">
            <dt>Surge</dt>
            <dd>×{fare.surgeMultiplier}</dd>
          </div>
        </dl>
      ) : (
        // A real, honest state, not a stale spinner: `fareEstimate` is only ever present on the
        // original POST /trips response, never on a later GET /trips/:id (docs/API.md) — so a
        // trip resumed after a page reload (useTripResume.ts, Frontend Phase 8) genuinely has no
        // fare estimate to show, permanently, not "not loaded yet."
        <p className="mt-3 border-t border-gray-200 pt-2 text-sm text-gray-500">
          Fare estimate isn't available for this trip.
        </p>
      )}

      {isTerminal && (
        <button
          type="button"
          onClick={onRequestAnother}
          className={`mt-4 w-full rounded border border-gray-300 px-4 text-sm ${TOUCH_TARGET_CLASS}`}
        >
          Request another trip
        </button>
      )}
    </div>
  );
}
