import type { DriverOfferPhase } from "../hooks/driverOfferReducer";
import { useCountdown } from "../hooks/useCountdown";
import { TOUCH_TARGET_CLASS } from "../ui";

export interface TripOfferPanelProps {
  phase: DriverOfferPhase;
  onAccept: () => void;
  onDecline: () => void;
}

/**
 * Renders every phase of driverOfferReducer.ts's state machine, including the two honest
 * "it didn't work out" terminal states — a plain expiry (never responded) and the real race this
 * phase is about (accepted, but the server had already moved on — docs/matching.md). Neither is
 * ever confused with "matched": the countdown itself is driven by the offer's own real
 * `offerTimeoutMs` (or, once responding, the confirmation grace deadline) via `useCountdown` — a
 * rendering-only concern; the actual expiry decision already happened in the reducer.
 */
export function TripOfferPanel({ phase, onAccept, onDecline }: TripOfferPanelProps) {
  const deadlineMs =
    phase.kind === "offered" ? phase.deadlineMs : phase.kind === "responding" ? phase.graceDeadlineMs : null;
  const remainingMs = useCountdown(deadlineMs);

  if (phase.kind === "idle") {
    return (
      <p className="text-sm text-gray-500" role="status">
        Waiting for a trip offer…
      </p>
    );
  }

  if (phase.kind === "offered") {
    const seconds = remainingMs !== null ? Math.ceil(remainingMs / 1000) : 0;
    return (
      <div className="rounded border border-blue-300 bg-blue-50 p-3">
        <p className="text-sm font-semibold">New trip offer</p>
        <p className="mt-1 font-mono text-xs text-gray-600">
          Pickup: {phase.offer.pickup.lat.toFixed(5)}, {phase.offer.pickup.lng.toFixed(5)}
        </p>
        <p className="font-mono text-xs text-gray-600">
          Dropoff: {phase.offer.dropoff.lat.toFixed(5)}, {phase.offer.dropoff.lng.toFixed(5)}
        </p>
        <p className="mt-2 font-mono text-sm" role="timer" aria-live="polite">
          {seconds}s to respond
        </p>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={onAccept}
            className={`flex-1 rounded bg-green-600 px-3 text-sm text-white ${TOUCH_TARGET_CLASS}`}
          >
            Accept
          </button>
          <button
            type="button"
            onClick={onDecline}
            className={`flex-1 rounded bg-gray-200 px-3 text-sm text-gray-800 ${TOUCH_TARGET_CLASS}`}
          >
            Decline
          </button>
        </div>
      </div>
    );
  }

  if (phase.kind === "responding") {
    return (
      <div className="rounded border border-amber-300 bg-amber-50 p-3" role="status" aria-live="polite">
        <p className="text-sm">Waiting for confirmation…</p>
      </div>
    );
  }

  if (phase.kind === "expired") {
    return (
      <p role="alert" className="text-sm text-amber-700">
        {phase.reason === "no_response"
          ? "You didn't respond in time — this offer expired."
          : "Your response arrived too late — this trip was already given to another driver."}
      </p>
    );
  }

  if (phase.kind === "declined") {
    return (
      <p className="text-sm text-gray-500" role="status">
        You declined this trip.
      </p>
    );
  }

  // phase.kind === "matched"
  return (
    <div className="rounded border border-green-300 bg-green-50 p-3" role="status">
      <p className="text-sm font-semibold text-green-700">Matched! En route to pickup.</p>
      <p className="mt-1 font-mono text-xs text-gray-600">
        Pickup: {phase.pickup.lat.toFixed(5)}, {phase.pickup.lng.toFixed(5)}
      </p>
    </div>
  );
}
