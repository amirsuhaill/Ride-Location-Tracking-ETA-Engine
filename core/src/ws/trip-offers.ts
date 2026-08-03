// Bridges the matching service's "wait for this driver to respond" step with the WS message
// handler that actually receives the driver's response — matching.service.ts creates a promise
// via waitForDriverResponse() and awaits it; driver-connections.ts calls handleDriverResponse()
// when a "trip_response" message arrives. At most one offer is ever outstanding per trip (a
// trip is only ever being matched by one matchTrip() call at a time), so tripId is a sufficient
// key.
interface PendingOffer {
  resolve: (accepted: boolean) => void;
}

const pendingOffers = new Map<string, PendingOffer>();

export function waitForDriverResponse(tripId: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingOffers.delete(tripId);
      resolve(false); // no response in time = treated the same as a decline
    }, timeoutMs);

    pendingOffers.set(tripId, {
      resolve: (accepted) => {
        clearTimeout(timer);
        pendingOffers.delete(tripId);
        resolve(accepted);
      },
    });
  });
}

/** Returns true if a matchTrip() call was actually waiting on this tripId (so the caller can
 * distinguish a genuine response from a stray/late one after the offer already expired). */
export function handleDriverResponse(tripId: string, accepted: boolean): boolean {
  const pending = pendingOffers.get(tripId);
  if (!pending) return false;
  pending.resolve(accepted);
  return true;
}

export function resetTripOffersForTests(): void {
  pendingOffers.clear();
}
