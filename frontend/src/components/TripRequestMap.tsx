import { useState } from "react";
import { MapContainer, Marker, TileLayer, useMapEvent, ZoomControl } from "react-leaflet";
import type { LatLngBoundsExpression } from "leaflet";
import "leaflet/dist/leaflet.css";
import type { LatLng } from "../api/types";
import { SF_BBOX } from "../constants";
import { dotIcon } from "../leafletIcons";
import { CoordinateEntryForm } from "./CoordinateEntryForm";

const SF_BOUNDS: LatLngBoundsExpression = [
  [SF_BBOX.minLat, SF_BBOX.minLng],
  [SF_BBOX.maxLat, SF_BBOX.maxLng],
];

const PICKUP_ICON = dotIcon("#7c3aed"); // violet
const DROPOFF_ICON = dotIcon("#ea580c"); // orange

type PinKind = "pickup" | "dropoff";

function MapClickHandler({ onClick, disabled }: { onClick: (point: LatLng) => void; disabled: boolean }) {
  useMapEvent("click", (e) => {
    if (disabled) return;
    onClick({ lat: e.latlng.lat, lng: e.latlng.lng });
  });
  return null;
}

export interface TripRequestMapProps {
  pickup: LatLng | null;
  dropoff: LatLng | null;
  onSetPickup: (point: LatLng) => void;
  onSetDropoff: (point: LatLng) => void;
  /** true once the trip has been successfully submitted — pins stop being editable. */
  locked: boolean;
}

/**
 * A tap/click two-pin picker: the FIRST tap places pickup and auto-advances to dropoff; the
 * SECOND tap places dropoff. Once both are placed, either pin can still be corrected — drag it
 * (works regardless of which pin is "active"), or tap the *other* pin to make it active again so
 * the next map tap revises it (not a one-shot placement that can't be revised). A status banner
 * always names which pin the next tap will affect.
 */
export function TripRequestMap({
  pickup,
  dropoff,
  onSetPickup,
  onSetDropoff,
  locked,
}: TripRequestMapProps) {
  const [activePin, setActivePin] = useState<PinKind>("pickup");

  function handleMapClick(point: LatLng): void {
    if (activePin === "pickup") {
      onSetPickup(point);
      setActivePin("dropoff"); // auto-advance — the natural next step after placing pickup
    } else {
      onSetDropoff(point);
      // stays "dropoff" — a further tap keeps revising dropoff, matching "retap to correct"
    }
  }

  const statusText = locked
    ? "Pickup and dropoff are set."
    : activePin === "pickup"
      ? pickup
        ? "Tap the map to move pickup, or tap the dropoff pin to switch to it."
        : "Tap the map to set your pickup point."
      : dropoff
        ? "Tap the map to move dropoff, or tap the pickup pin to switch to it."
        : "Tap the map to set your dropoff point.";

  return (
    <div className="relative h-full w-full">
      {/* Leaflet's own zoom control moves to the top-right — this app's own status
          banner/coordinate-entry overlays already claim the top-left corner (see below), and
          without this they'd visually cover Leaflet's default top-left zoom buttons entirely. */}
      <MapContainer bounds={SF_BOUNDS} zoomControl={false} className="h-full w-full">
        <ZoomControl position="topright" />
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        />
        <MapClickHandler onClick={handleMapClick} disabled={locked} />

        {pickup && (
          <Marker
            position={[pickup.lat, pickup.lng]}
            icon={PICKUP_ICON}
            draggable={!locked}
            title="Pickup"
            eventHandlers={{
              click: () => setActivePin("pickup"),
              dragend: (e) => onSetPickup(e.target.getLatLng()),
            }}
          />
        )}

        {dropoff && (
          <Marker
            position={[dropoff.lat, dropoff.lng]}
            icon={DROPOFF_ICON}
            draggable={!locked}
            title="Dropoff"
            eventHandlers={{
              click: () => setActivePin("dropoff"),
              dragend: (e) => onSetDropoff(e.target.getLatLng()),
            }}
          />
        )}
      </MapContainer>

      <div
        className="absolute left-2 top-2 z-[1000] max-w-[calc(100%-1rem)] rounded bg-white px-3 py-1.5 text-sm shadow"
        role="status"
        aria-live="polite"
      >
        {statusText}
      </div>

      {!locked && (
        // Placed below the status banner, not near the bottom edge — on phone, TripRequestFlow
        // renders this map full-bleed behind a BottomSheet that overlays the whole bottom edge
        // (docs/frontend-responsive.md), so anything anchored to the bottom here would risk
        // sitting underneath it.
        <div className="absolute left-2 top-14 z-[1000]">
          <CoordinateEntryForm
            label={`Set ${activePin} by coordinates`}
            onSubmit={handleMapClick}
          />
        </div>
      )}
    </div>
  );
}
