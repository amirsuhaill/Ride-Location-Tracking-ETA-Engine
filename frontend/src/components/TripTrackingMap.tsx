import { MapContainer, Marker, TileLayer } from "react-leaflet";
import type { LatLngBoundsExpression } from "leaflet";
import "leaflet/dist/leaflet.css";
import type { LatLng } from "../api/types";
import { SF_BBOX } from "../constants";
import { dotIcon } from "../leafletIcons";
import type { LastKnownState } from "../ws/deltaCodec";

const SF_BOUNDS: LatLngBoundsExpression = [
  [SF_BBOX.minLat, SF_BBOX.minLng],
  [SF_BBOX.maxLat, SF_BBOX.maxLng],
];

const PICKUP_ICON = dotIcon("#7c3aed"); // violet — matches TripRequestMap's pickup color
const DROPOFF_ICON = dotIcon("#ea580c"); // orange — matches TripRequestMap's dropoff color
const DRIVER_ICON = dotIcon("#16a34a"); // green — matches DriverMap's tracked-driver color

export interface TripTrackingMapProps {
  pickup: LatLng;
  dropoff: LatLng;
  driverPosition: LastKnownState | null;
}

/** Read-only once a trip is requested: pickup/dropoff pins are now fixed (no more
 * dragging/retapping — that's TripRequestMap's job, before submit), plus the assigned driver's
 * live position once matched, moving as real broadcast messages arrive
 * (useTripTracking/deltaCodec). */
export function TripTrackingMap({ pickup, dropoff, driverPosition }: TripTrackingMapProps) {
  return (
    <MapContainer bounds={SF_BOUNDS} className="h-full w-full">
      <TileLayer
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      />
      <Marker position={[pickup.lat, pickup.lng]} icon={PICKUP_ICON} title="Pickup" />
      <Marker position={[dropoff.lat, dropoff.lng]} icon={DROPOFF_ICON} title="Dropoff" />
      {driverPosition && (
        <Marker
          position={[driverPosition.lat, driverPosition.lng]}
          icon={DRIVER_ICON}
          title="Driver"
        />
      )}
    </MapContainer>
  );
}
