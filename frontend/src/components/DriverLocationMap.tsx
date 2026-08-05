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

const DRIVER_ICON = dotIcon("#2563eb"); // matches DriverMap's default online-driver color

function ClickToSetHandler({ onClick }: { onClick: (point: LatLng) => void }) {
  useMapEvent("click", (e) => onClick({ lat: e.latlng.lat, lng: e.latlng.lng }));
  return null;
}

export interface DriverLocationMapProps {
  position: LatLng | null;
  onManualSet: (point: LatLng) => void;
}

/** The driver's own map: shows the last position actually sent (whichever source sent it — real
 * Geolocation or a manual click, see useDriverLocationStream), and lets clicking anywhere set
 * a position manually — the fallback for desktop development with no real GPS. Also offers the
 * exact same "set manually" action as a keyboard-operable coordinate form (Frontend Phase 7 —
 * clicking the map has no keyboard equivalent otherwise). */
export function DriverLocationMap({ position, onManualSet }: DriverLocationMapProps) {
  return (
    <div className="relative h-full w-full">
      {/* Zoom control moves to top-right — the coordinate-entry toggle below claims top-left,
          and would otherwise sit directly on top of Leaflet's default top-left zoom buttons. */}
      <MapContainer bounds={SF_BOUNDS} zoomControl={false} className="h-full w-full">
        <ZoomControl position="topright" />
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        />
        <ClickToSetHandler onClick={onManualSet} />
        {position && <Marker position={[position.lat, position.lng]} icon={DRIVER_ICON} title="You" />}
      </MapContainer>

      <div className="absolute left-2 top-2 z-[1000]">
        <CoordinateEntryForm label="Set your position by coordinates" onSubmit={onManualSet} />
      </div>
    </div>
  );
}
