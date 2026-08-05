import { useEffect, useRef, useState } from "react";
import { createTrip, describeApiFailure, getTrip } from "../api/client";
import type { LatLng, Trip } from "../api/types";
import { useBreakpoint } from "../hooks/useBreakpoint";
import { useSurgeAtPoint } from "../hooks/useSurgeAtPoint";
import { useTripEta } from "../hooks/useTripEta";
import { useTripTracking } from "../hooks/useTripTracking";
import { formatCents } from "../format";
import { formatMultiplier } from "../surgeVisuals";
import { TOUCH_TARGET_CLASS } from "../ui";
import { BottomSheet } from "./BottomSheet";
import { ConnectionStatusBanner } from "./ConnectionStatusBanner";
import { TripRequestMap } from "./TripRequestMap";
import { TripTrackingMap } from "./TripTrackingMap";
import { TripTrackingPanel } from "./TripTrackingPanel";

export interface TripRequestFlowProps {
  riderId: string;
}

type FlowState =
  | { phase: "picking" }
  | { phase: "submitting" }
  | { phase: "error"; message: string }
  | { phase: "tracking"; trip: Trip };

const TERMINAL_STATUSES = new Set(["completed", "cancelled"]);
const STORAGE_TRIP_ID_KEY = "ride-tracking.currentTripId";

const TRACKING_PEEK_TEXT: Record<string, string> = {
  requested: "Looking for a nearby driver…",
  matched: "Driver matched — heading your way.",
  in_progress: "En route to dropoff.",
  completed: "Trip completed.",
  cancelled: "Trip cancelled.",
};

/**
 * Owns the whole rider request lifecycle: picking pickup/dropoff, submitting, then live
 * tracking. `submittingRef` is a plain mutable ref checked and set synchronously at the very top
 * of `handleSubmit` — a React state flag alone isn't a reliable double-submit guard, since two
 * click events dispatched back to back can both run before a state update has re-rendered the
 * button as disabled; a ref mutation has no such gap.
 */
export function TripRequestFlow({ riderId }: TripRequestFlowProps) {
  const [pickup, setPickup] = useState<LatLng | null>(null);
  const [dropoff, setDropoff] = useState<LatLng | null>(null);
  const [flow, setFlow] = useState<FlowState>({ phase: "picking" });
  const [resuming, setResuming] = useState(true);
  const submittingRef = useRef(false);

  // Real resilience, not just a WS reconnect: a page reload mid-trip shouldn't orphan an active
  // trip the rider is genuinely still on (Frontend Phase 8, docs/frontend-resilience.md). One-shot
  // check on mount only — this is recovering from a reload, not a poll loop. Resuming via
  // GET /trips/:id (rather than the original POST response, which no longer exists after a
  // reload) is also the one real, live-triggerable path to a trip with no `fareEstimate` at all:
  // that field is only ever present on the original POST /trips response (docs/API.md), never on
  // a later GET — see TripTrackingPanel's honest "Fare estimate isn't available" state for it.
  useEffect(() => {
    const storedTripId = localStorage.getItem(STORAGE_TRIP_ID_KEY);
    if (!storedTripId) {
      setResuming(false);
      return;
    }

    let cancelled = false;
    getTrip(storedTripId).then((result) => {
      if (cancelled) return;
      if (result.ok && !TERMINAL_STATUSES.has(result.data.status)) {
        setFlow({ phase: "tracking", trip: result.data });
      } else if (result.ok || (result.reason === "api_error" && result.code === "NOT_FOUND")) {
        // Either genuinely finished, or gone entirely — nothing left to resume.
        localStorage.removeItem(STORAGE_TRIP_ID_KEY);
      }
      // A network_error leaves the stored id in place untouched — this was a transient check
      // failure, not proof the trip is gone, so a later reload gets another real attempt.
      setResuming(false);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const trackedTripId = flow.phase === "tracking" ? flow.trip.id : null;
  const tracking = useTripTracking(trackedTripId);
  const isTerminal = TERMINAL_STATUSES.has(tracking.status);

  // The trip just reached a real terminal state — nothing left to resume even if the page
  // reloads from here, so stop remembering it.
  useEffect(() => {
    if (trackedTripId && isTerminal) {
      localStorage.removeItem(STORAGE_TRIP_ID_KEY);
    }
  }, [trackedTripId, isTerminal]);
  // A permanent ETA failure (useTripEta.ts's `error`) is a genuinely rare edge case here — trips
  // aren't deletable, so the only realistic trigger is the tripId itself being wrong somehow —
  // but is deliberately not surfaced as its own UI element beyond EtaBadge's existing "not
  // available yet" fallback for `eta: null`; the important behavioral fix is that the hook itself
  // stops polling a request that can only ever fail the same way again.
  const { eta } = useTripEta(trackedTripId, trackedTripId !== null && !isTerminal);

  const locked = flow.phase === "tracking";
  const canSubmit = pickup !== null && dropoff !== null && flow.phase === "picking";

  // Shows the pickup zone's real, current surge multiplier *before* the rider ever submits — the
  // exact same GET /surge?lat=&lng= read path POST /trips itself uses to price the fare, not a
  // separately re-derived guess (docs/surge-pricing.md: every read is a plain lookup of whatever
  // the last SURGE_UPDATE_INTERVAL_MS tick computed, so this and fareEstimate.surgeMultiplier can
  // only ever disagree if the pickup zone's multiplier changed between this read and submission —
  // never because the two are computed differently).
  const pickupSurge = useSurgeAtPoint(pickup, flow.phase === "picking");

  async function handleSubmit(): Promise<void> {
    if (submittingRef.current || !pickup || !dropoff) return;
    submittingRef.current = true;
    setFlow({ phase: "submitting" });

    const result = await createTrip({ riderId, pickup, dropoff });

    submittingRef.current = false;
    if (result.ok) {
      localStorage.setItem(STORAGE_TRIP_ID_KEY, result.data.id);
      setFlow({ phase: "tracking", trip: result.data });
    } else {
      // The backend's own exact message (a specific validation error, or a distinct
      // "can't reach the server" for a network failure) — never a generic fallback string.
      setFlow({ phase: "error", message: describeApiFailure(result) });
    }
  }

  function handleRequestAnother(): void {
    localStorage.removeItem(STORAGE_TRIP_ID_KEY);
    setPickup(null);
    setDropoff(null);
    setFlow({ phase: "picking" });
  }

  // "Peek": always visible regardless of collapsed/expanded state on phone (BottomSheet's
  // `header`) — the one primary action (submit, or "request another") is never gated behind an
  // extra expand gesture. "Detail": everything else, shown inline on tablet/desktop (no
  // collapse concept there) and only once expanded on phone (BottomSheet's `children`).
  const pickingPeek = (
    <div>
      <h2 className="text-base font-semibold">Request a ride</h2>
      <p className="mt-1 text-sm text-gray-600">
        Pickup {pickup ? "set" : "not set"} · Dropoff {dropoff ? "set" : "not set"}
      </p>
      {flow.phase === "error" && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {flow.message}
        </p>
      )}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={!canSubmit || locked}
        className={`mt-3 w-full rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50 ${TOUCH_TARGET_CLASS}`}
      >
        {flow.phase === "submitting" ? "Requesting…" : "Request ride"}
      </button>
    </div>
  );

  const pickingDetail = (
    <dl className="space-y-1 pb-4 text-sm text-gray-600">
      <div className="flex justify-between">
        <dt>Pickup</dt>
        <dd className="font-mono">
          {pickup ? `${pickup.lat.toFixed(5)}, ${pickup.lng.toFixed(5)}` : "not set"}
        </dd>
      </div>
      <div className="flex justify-between">
        <dt>Dropoff</dt>
        <dd className="font-mono">
          {dropoff ? `${dropoff.lat.toFixed(5)}, ${dropoff.lng.toFixed(5)}` : "not set"}
        </dd>
      </div>
      {pickup && (
        <div className="flex justify-between" role="status" aria-live="polite">
          <dt>Current surge here</dt>
          <dd className="font-mono">
            {pickupSurge.error
              ? "not available"
              : pickupSurge.surge
                ? formatMultiplier(pickupSurge.surge.multiplier)
                : "loading…"}
          </dd>
        </div>
      )}
    </dl>
  );

  const trackingPeek = flow.phase === "tracking" && (
    <div>
      <p className="text-sm font-semibold">
        Trip <span className="font-mono text-xs font-normal text-gray-500">{flow.trip.id.slice(0, 8)}…</span>
      </p>
      <ConnectionStatusBanner state={tracking.connectionState} />
      <p className="text-sm text-gray-700">{TRACKING_PEEK_TEXT[tracking.status] ?? tracking.status}</p>
      {flow.trip.fareEstimate && (
        <p className="text-sm font-semibold">
          {formatCents(flow.trip.fareEstimate.totalCents, flow.trip.fareEstimate.currency)}
        </p>
      )}
      {isTerminal && (
        <button
          type="button"
          onClick={handleRequestAnother}
          className={`mt-2 w-full rounded border border-gray-300 px-4 py-2 text-sm ${TOUCH_TARGET_CLASS}`}
        >
          Request another trip
        </button>
      )}
    </div>
  );

  const trackingDetail = flow.phase === "tracking" && (
    <div className="pb-4">
      <TripTrackingPanel
        trip={flow.trip}
        tracking={tracking}
        connectionState={tracking.connectionState}
        eta={eta}
        onRequestAnother={handleRequestAnother}
      />
    </div>
  );

  const peek = flow.phase === "tracking" ? trackingPeek : pickingPeek;
  const detail = flow.phase === "tracking" ? trackingDetail : pickingDetail;

  const breakpoint = useBreakpoint();
  const isPhone = breakpoint === "phone";

  // A real, one-shot check (GET /trips/:id against a locally-remembered tripId), not a fake
  // delay — brief enough in practice that it's easy to miss, but honest about what's actually
  // happening rather than jumping straight to "picking" and then yanking the rider into
  // "tracking" a moment later if a resume turns out to apply.
  if (resuming) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-gray-600">
        Checking for an active trip…
      </div>
    );
  }

  return (
    <div className={`relative h-full w-full ${isPhone ? "" : "flex flex-row"}`}>
      {/* Phone (< 640px): map fills the entire screen behind a draggable bottom sheet — see
          docs/frontend-responsive.md. Tablet/desktop (>= 640px): a conventional side panel next
          to the map instead, no overlay/sheet at all. Which ONE of the two gets rendered is
          decided once here (useBreakpoint), not by mounting both and hiding one with CSS — two
          mounted copies of the same interactive controls (submit/accept/etc.) would be a genuine
          duplicate-tab-stop trap for keyboard/assistive tech, not just visual redundancy. */}
      <div className={isPhone ? "absolute inset-0" : "h-full flex-1"}>
        {flow.phase === "tracking" ? (
          <TripTrackingMap
            pickup={flow.trip.pickup}
            dropoff={flow.trip.dropoff}
            driverPosition={tracking.driverPosition}
          />
        ) : (
          <TripRequestMap
            pickup={pickup}
            dropoff={dropoff}
            onSetPickup={setPickup}
            onSetDropoff={setDropoff}
            locked={false}
          />
        )}
      </div>

      {isPhone ? (
        <BottomSheet label="Trip details" header={peek}>
          {detail}
        </BottomSheet>
      ) : (
        // Desktop (>= 1024px) widens the panel from 320px to 384px (lg:w-96) — real breathing
        // room for the fare/ETA line items once there's enough horizontal space to spend on it,
        // not a font-size change. No separate "peek" here while tracking — the full panel below
        // already includes the status/fare summary the phone sheet's collapsed peek repeats, so
        // showing both would just duplicate the same trip id/status/fare twice on one screen.
        <div className="h-full w-80 flex-none overflow-y-auto border-l border-gray-200 p-4 lg:w-96">
          {flow.phase === "tracking" ? (
            detail
          ) : (
            <>
              {peek}
              <div className="mt-3 border-t border-gray-200 pt-3">{detail}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
