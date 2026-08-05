import { useCallback, useEffect, useState } from "react";
import { MapContainer, Marker, TileLayer, useMap, useMapEvent, ZoomControl } from "react-leaflet";
import type { LatLngBoundsExpression } from "leaflet";
import "leaflet/dist/leaflet.css";
import { getNearbyDrivers } from "../api/client";
import type { NearbyDriver } from "../api/types";
import { NEARBY_MAX_RADIUS_METERS, SF_BBOX } from "../constants";
import { useDriverTracking } from "../hooks/useDriverTracking";
import { useSurgeZones } from "../hooks/useSurgeZones";
import { dotIcon } from "../leafletIcons";
import { FOCUS_RING_CLASS, TOUCH_TARGET_CLASS } from "../ui";
import { SurgeOverlay } from "./SurgeOverlay";

const SF_BOUNDS: LatLngBoundsExpression = [
  [SF_BBOX.minLat, SF_BBOX.minLng],
  [SF_BBOX.maxLat, SF_BBOX.maxLng],
];

const DEFAULT_ICON = dotIcon("#2563eb");
const TRACKED_ICON = dotIcon("#16a34a");

/** Refetches GET /drivers/nearby whenever the map's viewport settles (pan/zoom end) — centered
 * on the current view, radius sized to reach the visible viewport's farthest corner, clamped to
 * NEARBY_MAX_RADIUS_METERS (core's own hard cap) so zooming out never sends a request core would
 * reject with a 400. */
function ViewportDriverFetcher({ onDrivers }: { onDrivers: (drivers: NearbyDriver[]) => void }) {
  const map = useMap();

  const refetch = useCallback(() => {
    const center = map.getCenter();
    const bounds = map.getBounds();
    const radiusMeters = Math.min(
      map.distance(center, bounds.getNorthEast()),
      NEARBY_MAX_RADIUS_METERS,
    );
    getNearbyDrivers({
      lat: center.lat,
      lng: center.lng,
      radius: Math.max(1, Math.round(radiusMeters)),
      limit: 100,
    }).then((result) => {
      if (result.ok) onDrivers(result.data.drivers);
    });
  }, [map, onDrivers]);

  useMapEvent("moveend", refetch);
  useEffect(() => {
    refetch();
  }, [refetch]);

  return null;
}

const CONNECTION_LABEL: Record<string, string> = {
  connecting: "connecting…",
  connected: "live",
  reconnecting: "reconnecting…",
  closed: "not tracking",
};

export interface DriverMapProps {
  trackedDriverId: string | null;
  onSelectDriver: (driverId: string | null) => void;
}

/**
 * Read-only fleet map: every online driver within the current viewport (via GET /drivers/nearby,
 * refetched on pan/zoom), keyed by driverId so React never remounts a marker just because the
 * underlying array reference changed on refetch. Clicking a marker switches it into "live
 * tracking" — a real /ws/subscribe connection for that one driver (useDriverTracking) — clicking
 * it again (or another marker) tears that connection down and, if applicable, opens a new one.
 *
 * Also the one live "surge map" in this app (Frontend Phase 6) — SurgeOverlay renders every
 * currently-tracked zone from GET /surge underneath the driver markers, polled on
 * SURGE_UPDATE_INTERVAL_MS, the same real interval the backend recomputes it on.
 */
export function DriverMap({ trackedDriverId, onSelectDriver }: DriverMapProps) {
  const [drivers, setDrivers] = useState<NearbyDriver[]>([]);
  // Distinct from `drivers.length === 0` — that's also true before the very first fetch has ever
  // completed. Only once `handleDrivers` has actually run at least once (even with a genuinely
  // empty result) is "no drivers nearby" an honest thing to say, rather than a still-loading map
  // that just happens to render the same as an empty one (Frontend Phase 8).
  const [driversLoaded, setDriversLoaded] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const { connectionState, position } = useDriverTracking(trackedDriverId);
  const { zones: surgeZones, hasLoaded: surgeLoaded } = useSurgeZones();

  function handleDrivers(next: NearbyDriver[]): void {
    setDrivers(next);
    setDriversLoaded(true);
  }

  const trackedRestDriver = drivers.find((d) => d.driverId === trackedDriverId);
  const otherDrivers = drivers.filter((d) => d.driverId !== trackedDriverId);

  // Until the first real broadcast arrives (subscribing doesn't get an immediate snapshot — see
  // docs/websockets.md — only the driver's *next* location update does), fall back to the last
  // REST-known position so the tracked marker doesn't disappear the moment it's selected.
  const trackedPosition =
    position ?? (trackedRestDriver ? { ...trackedRestDriver.location, status: "online" as const } : null);

  return (
    <div className="relative h-full w-full">
      {/* Zoom control moves to the bottom-right — this screen's own overlays already claim both
          top corners (the driver list at top-left, the tracking status badge at top-right), and
          there's no bottom sheet here to collide with either (unlike the rider/driver screens). */}
      <MapContainer bounds={SF_BOUNDS} zoomControl={false} className="h-full w-full">
        <ZoomControl position="bottomright" />
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        />
        <ViewportDriverFetcher onDrivers={handleDrivers} />
        <SurgeOverlay zones={surgeZones} />

        {otherDrivers.map((driver) => (
          <Marker
            key={driver.driverId}
            position={[driver.location.lat, driver.location.lng]}
            icon={DEFAULT_ICON}
            title={driver.driverId}
            eventHandlers={{ click: () => onSelectDriver(driver.driverId) }}
          />
        ))}

        {trackedDriverId && trackedPosition && (
          <Marker
            key={trackedDriverId}
            position={[trackedPosition.lat, trackedPosition.lng]}
            icon={TRACKED_ICON}
            title={trackedDriverId}
            eventHandlers={{ click: () => onSelectDriver(null) }}
          />
        )}
      </MapContainer>

      {trackedDriverId && (
        <div
          className="absolute right-2 top-2 z-[1000] rounded bg-white px-3 py-1.5 text-sm shadow"
          role="status"
          aria-live="polite"
        >
          Tracking {trackedDriverId.slice(0, 8)}… — {CONNECTION_LABEL[connectionState]}
          {trackedPosition && (
            <span className="ml-2 font-mono text-xs text-gray-500">
              {trackedPosition.lat.toFixed(5)}, {trackedPosition.lng.toFixed(5)}
            </span>
          )}
        </div>
      )}

      {/* Honest empty states (Frontend Phase 8, docs/frontend-resilience.md) — each only renders
          once its own data has genuinely loaded at least once (`driversLoaded`/`surgeLoaded`),
          so a page that simply hasn't fetched yet is never mistaken for a confirmed "there's
          nothing here." Bottom-left: the one corner none of this screen's other overlays use. */}
      <div className="absolute bottom-2 left-2 z-[1000] flex flex-col gap-1">
        {driversLoaded && drivers.length === 0 && (
          <p role="status" className="rounded bg-white px-3 py-1.5 text-xs text-gray-600 shadow">
            No drivers online nearby right now.
          </p>
        )}
        {surgeLoaded && surgeZones.length === 0 && (
          <p role="status" className="rounded bg-white px-3 py-1.5 text-xs text-gray-600 shadow">
            No zones currently showing surge.
          </p>
        )}
      </div>

      {/* A marker click has no keyboard equivalent — this list exposes the exact same "select
          this driver to track" action as a plain, Tab-reachable button per driver (Frontend
          Phase 7's keyboard-navigation pass, docs/frontend-responsive.md). */}
      <div className="absolute left-2 top-2 z-[1000]">
        <button
          type="button"
          onClick={() => setListOpen((v) => !v)}
          aria-expanded={listOpen}
          className={`rounded bg-white px-3 text-sm text-gray-700 shadow ${TOUCH_TARGET_CLASS} ${FOCUS_RING_CLASS}`}
        >
          Drivers ({drivers.length})
        </button>
        {listOpen && (
          <ul className="mt-1 max-h-64 w-56 overflow-y-auto rounded bg-white shadow" aria-label="Drivers">
            {drivers.length === 0 && <li className="p-3 text-xs text-gray-500">No drivers in view.</li>}
            {drivers.map((driver) => (
              <li key={driver.driverId}>
                <button
                  type="button"
                  onClick={() => onSelectDriver(driver.driverId === trackedDriverId ? null : driver.driverId)}
                  className={`flex w-full items-center justify-between px-3 text-left text-xs ${TOUCH_TARGET_CLASS} ${FOCUS_RING_CLASS} ${
                    driver.driverId === trackedDriverId ? "bg-green-50 font-semibold" : ""
                  }`}
                >
                  <span className="font-mono">{driver.driverId.slice(0, 8)}…</span>
                  {driver.driverId === trackedDriverId && <span aria-hidden="true">✓</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
