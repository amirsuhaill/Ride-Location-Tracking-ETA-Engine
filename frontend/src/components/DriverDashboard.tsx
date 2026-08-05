import { useRef, useState } from "react";
import { describeApiFailure, patchDriverStatus } from "../api/client";
import type { Driver, DriverStatus } from "../api/types";
import { canTransitionDriverStatus } from "../driverStatusRules";
import { useBreakpoint } from "../hooks/useBreakpoint";
import { useDriverConnection } from "../hooks/useDriverConnection";
import { TOUCH_TARGET_CLASS } from "../ui";
import { BottomSheet } from "./BottomSheet";
import { ConnectionStatusBanner } from "./ConnectionStatusBanner";
import { DriverLocationMap } from "./DriverLocationMap";
import { GeolocationStatusBanner } from "./GeolocationStatusBanner";
import { TripOfferPanel } from "./TripOfferPanel";

export interface DriverDashboardProps {
  driver: Driver;
}

const CONNECTION_LABEL: Record<string, string> = {
  connecting: "connecting…",
  connected: "streaming",
  reconnecting: "reconnecting…",
  closed: "not connected",
};

/**
 * The driver-facing dashboard: an online/offline toggle (client-side mirrors docs/API.md's
 * legal-transition table for instant feedback — driverStatusRules.ts), a real location stream
 * while online (Frontend Phase 4), and — on that exact same /ws/driver connection — trip offers
 * with a real countdown and accept/decline (Frontend Phase 5). All owned by one hook
 * (useDriverConnection) since they share one WebSocket connection.
 */
export function DriverDashboard({ driver: initialDriver }: DriverDashboardProps) {
  const [driverId] = useState(initialDriver.id);
  const [status, setStatus] = useState<DriverStatus>(initialDriver.status);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [changingStatus, setChangingStatus] = useState(false);
  const changingRef = useRef(false);

  const connection = useDriverConnection(driverId, status === "online");

  // The server flips the driver's own status to "busy" the moment a match finalizes
  // (matching.service.ts#tryOfferToDriver), but that state change is never itself pushed back to
  // this client (trip_matched carries only {tripId, pickup, dropoff} — no status field). Rather
  // than let the toggle offer an 409-doomed "go offline" the instant offerPhase says "matched",
  // treat "matched" as busy for the toggle's purposes too — an honest reflection of what the
  // server just decided, even before any PATCH round-trip confirms it.
  const effectiveStatus: DriverStatus = connection.offerPhase.kind === "matched" ? "busy" : status;

  async function handleToggle(): Promise<void> {
    if (changingRef.current) return;
    const target: DriverStatus = effectiveStatus === "online" ? "offline" : "online";
    if (!canTransitionDriverStatus(effectiveStatus, target)) return;

    changingRef.current = true;
    setChangingStatus(true);
    setStatusError(null);

    const result = await patchDriverStatus(driverId, target);

    changingRef.current = false;
    setChangingStatus(false);
    if (result.ok) {
      setStatus(result.data.status);
    } else {
      setStatusError(describeApiFailure(result));
    }
  }

  const toggleTarget: DriverStatus = effectiveStatus === "online" ? "offline" : "online";
  const canToggle = effectiveStatus !== "busy" && canTransitionDriverStatus(effectiveStatus, toggleTarget);

  // "Peek": always visible on phone (BottomSheet's `header`), never gated behind an expand
  // gesture — critically, this includes TripOfferPanel, since a real trip offer is a real
  // countdown (Frontend Phase 5); hiding "Accept"/"Decline" behind "expand" on a phone would be a
  // genuine usability regression, not just a cosmetic one. Same reasoning applies to a dropped
  // WebSocket (Frontend Phase 8) — a driver whose connection is silently reconnecting in the
  // background while location updates stop being sent is exactly the kind of thing that shouldn't
  // require an extra "expand" tap to notice. "Detail": lower-urgency diagnostics that can wait
  // (geolocation status, the granular connection label, last sent position) — shown inline on
  // tablet/desktop, and only once expanded on phone.
  const peek = (
    <div>
      <h2 className="text-base font-semibold">{initialDriver.name}</h2>
      <p className="text-sm text-gray-500">
        {initialDriver.vehicleColor} {initialDriver.vehicleMake} {initialDriver.vehicleModel} ·{" "}
        {initialDriver.vehiclePlate}
      </p>
      {status === "online" && <ConnectionStatusBanner state={connection.connectionState} />}

      <div className="mt-3">
        {effectiveStatus === "busy" ? (
          <p className="text-sm text-gray-600">You're on a trip — can't go offline until it ends.</p>
        ) : (
          <button
            type="button"
            onClick={handleToggle}
            disabled={changingStatus || !canToggle}
            className={`w-full rounded px-4 py-2 text-white disabled:opacity-50 ${TOUCH_TARGET_CLASS} ${
              effectiveStatus === "online" ? "bg-gray-700" : "bg-blue-600"
            }`}
          >
            {changingStatus ? "Updating…" : effectiveStatus === "online" ? "Go offline" : "Go online"}
          </button>
        )}
        {statusError && (
          <p role="alert" className="mt-2 text-sm text-red-600">
            {statusError}
          </p>
        )}
      </div>

      {status === "online" && (
        <div className="mt-3 border-t border-gray-200 pt-3">
          <TripOfferPanel
            phase={connection.offerPhase}
            onAccept={connection.acceptOffer}
            onDecline={connection.declineOffer}
          />
        </div>
      )}
    </div>
  );

  const detail = status === "online" && (
    <div className="space-y-2 pb-4">
      <GeolocationStatusBanner status={connection.geolocationStatus} />
      <p className="text-sm" role="status">
        Connection: {CONNECTION_LABEL[connection.connectionState]}
      </p>
      {connection.lastSentPosition && (
        <p className="font-mono text-xs text-gray-500">
          Last sent: {connection.lastSentPosition.lat.toFixed(5)},{" "}
          {connection.lastSentPosition.lng.toFixed(5)}
        </p>
      )}
    </div>
  );

  const breakpoint = useBreakpoint();
  const isPhone = breakpoint === "phone";

  return (
    <div className={`relative h-full w-full ${isPhone ? "" : "flex flex-row"}`}>
      {/* Phone (< 640px): map fills the entire screen behind a draggable bottom sheet — see
          docs/frontend-responsive.md. Tablet/desktop (>= 640px): a conventional side panel next
          to the map instead. One variant is chosen here (useBreakpoint), never both mounted at
          once — see TripRequestFlow.tsx for why. */}
      <div className={isPhone ? "absolute inset-0" : "h-full flex-1"}>
        {status === "online" ? (
          <DriverLocationMap
            position={connection.lastSentPosition}
            onManualSet={connection.sendManualPosition}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-gray-500">
            Go online to start sharing your location.
          </div>
        )}
      </div>

      {isPhone ? (
        <BottomSheet label="Driver status" header={peek}>
          {detail}
        </BottomSheet>
      ) : (
        // Desktop (>= 1024px) widens the panel from 320px to 384px (lg:w-96), same real
        // rationale as the rider flow's panel (docs/frontend-responsive.md).
        <div className="h-full w-80 flex-none overflow-y-auto border-l border-gray-200 p-4 lg:w-96">
          {peek}
          {detail && <div className="mt-3 border-t border-gray-200 pt-3">{detail}</div>}
        </div>
      )}
    </div>
  );
}
