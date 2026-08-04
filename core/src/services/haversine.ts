export interface LatLng {
  lat: number;
  lng: number;
}

// Mean Earth radius in meters — same spherical model PostGIS's `geography` type uses (see
// docs/schema.md's geography-vs-geometry rationale), so this stays consistent with how distances
// are computed elsewhere in this project (Redis GEO, PostGIS ST_Distance).
const EARTH_RADIUS_METERS = 6_371_000;

/**
 * Great-circle distance between two lat/lng points, in meters, via the haversine formula.
 * Validated against known real-world airport pairs in test/eta-haversine.test.ts — see
 * docs/eta.md for the exact reference values and tolerance rationale (a spherical mean-radius
 * model is inherently ~0.2-0.5% off from ellipsoidal/geodesic references, which is expected and
 * fine at rideshare distances).
 */
export function haversineDistanceMeters(a: LatLng, b: LatLng): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;

  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));

  return EARTH_RADIUS_METERS * c;
}
