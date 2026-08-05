import L from "leaflet";
import { TOUCH_TARGET_PX } from "./ui";

// Leaflet's default marker image (marker-icon.png etc.) resolves relative to the page URL, which
// breaks under Vite's bundling — the standard fix is either re-pointing L.Icon.Default at
// bundled asset URLs, or (simpler here, no extra image assets to manage) a plain colored-dot
// divIcon. No functional loss for this project's use case (a moving vehicle dot, not a pin).
//
// The *visible* dot stays small (14px) — a city map covered in 44px blobs would be unreadable —
// but Leaflet's clickable/tappable area is exactly `iconSize`, so a 14px `iconSize` would also be
// a 14px touch target, well under this project's stated 44px minimum (docs/frontend-responsive.md,
// see ui.ts). The fix: the icon's own bounding box is TOUCH_TARGET_PX square (invisible, centered
// on the marker's true geo position via a matching iconAnchor), with the small visible dot
// centered inside it — the tap target grows without the map looking any busier.
const DOT_VISUAL_PX = 14;

export function dotIcon(color: string): L.DivIcon {
  const half = TOUCH_TARGET_PX / 2;
  return L.divIcon({
    className: "",
    html: `<span style="display:flex;align-items:center;justify-content:center;width:${TOUCH_TARGET_PX}px;height:${TOUCH_TARGET_PX}px;"><span style="display:block;width:${DOT_VISUAL_PX}px;height:${DOT_VISUAL_PX}px;border-radius:9999px;background:${color};border:2px solid white;box-shadow:0 0 0 1px rgba(0,0,0,0.25);"></span></span>`,
    iconSize: [TOUCH_TARGET_PX, TOUCH_TARGET_PX],
    iconAnchor: [half, half],
  });
}
