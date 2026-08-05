import { Circle, Tooltip } from "react-leaflet";
import type { SurgeZone } from "../api/types";
import { SURGE_ZONE_RADIUS_METERS } from "../constants";
import { formatMultiplier, surgeFillColor, surgeFillOpacity } from "../surgeVisuals";

export interface SurgeOverlayProps {
  zones: SurgeZone[];
}

/**
 * One circle per currently-tracked surge zone (GET /surge), sized with this project's own real
 * SURGE_ZONE_RADIUS_METERS around the zone's returned `center` — never an invented radius. Color
 * intensity (pale amber -> deep red) encodes the multiplier, but color is never the *only*
 * signal: every zone also carries a permanent, always-visible numeric label (e.g. "1.4x") via a
 * permanent Tooltip, so a colorblind viewer (or a black-and-white printout) still gets the exact
 * same information a sighted color-viewer does.
 */
export function SurgeOverlay({ zones }: SurgeOverlayProps) {
  return (
    <>
      {zones.map((zone) => (
        <Circle
          key={zone.zoneId}
          center={[zone.center.lat, zone.center.lng]}
          radius={SURGE_ZONE_RADIUS_METERS}
          pathOptions={{
            color: surgeFillColor(zone.multiplier),
            weight: 1,
            fillColor: surgeFillColor(zone.multiplier),
            fillOpacity: surgeFillOpacity(zone.multiplier),
          }}
        >
          <Tooltip permanent direction="center" className="surge-label">
            {formatMultiplier(zone.multiplier)}
          </Tooltip>
        </Circle>
      ))}
    </>
  );
}
