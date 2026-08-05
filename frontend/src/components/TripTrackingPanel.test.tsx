import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Trip } from "../api/types";
import type { TripTrackingState } from "../hooks/useTripTracking";
import { TripTrackingPanel } from "./TripTrackingPanel";

const BASE_TRIP: Trip = {
  id: "11111111-2222-3333-4444-555555555555",
  riderId: "r1",
  driverId: null,
  status: "requested",
  pickup: { lat: 37.7749, lng: -122.4194 },
  dropoff: { lat: 37.8044, lng: -122.2712 },
  requestedAt: "2026-08-05T00:00:00.000Z",
  matchedAt: null,
  startedAt: null,
  completedAt: null,
  distanceMeters: null,
  durationSeconds: null,
  cancellationReason: null,
};

const BASE_TRACKING: TripTrackingState = {
  status: "requested",
  driverId: null,
  driverPosition: null,
  cancellationReason: null,
};

function renderPanel(overrides: {
  trip?: Partial<Trip>;
  tracking?: Partial<TripTrackingState>;
  connectionState?: "connecting" | "connected" | "reconnecting" | "closed";
} = {}) {
  const trip = { ...BASE_TRIP, ...overrides.trip };
  const tracking = { ...BASE_TRACKING, ...overrides.tracking };
  return render(
    <TripTrackingPanel
      trip={trip}
      tracking={tracking}
      connectionState={overrides.connectionState ?? "connected"}
      eta={null}
      onRequestAnother={vi.fn()}
    />,
  );
}

describe("TripTrackingPanel: what each trip status renders", () => {
  it("'requested' shows a searching message, no terminal button", () => {
    renderPanel({ tracking: { status: "requested" } });
    expect(screen.getByText("Looking for a nearby driver…")).toBeInTheDocument();
    expect(screen.queryByText("Request another trip")).not.toBeInTheDocument();
  });

  it("'matched' shows a distinct, positive message", () => {
    renderPanel({ tracking: { status: "matched", driverId: "d1" } });
    expect(screen.getByText("A driver has been matched and is heading your way.")).toBeInTheDocument();
    expect(screen.queryByText("Request another trip")).not.toBeInTheDocument();
  });

  it("'in_progress' shows a distinct en-route message, different from 'matched'", () => {
    renderPanel({ tracking: { status: "in_progress", driverId: "d1" } });
    expect(screen.getByText("Your driver is en route to the dropoff.")).toBeInTheDocument();
    expect(
      screen.queryByText("A driver has been matched and is heading your way."),
    ).not.toBeInTheDocument();
  });

  it("'completed' shows a completion message AND the terminal 'Request another trip' button", () => {
    renderPanel({ tracking: { status: "completed" } });
    expect(screen.getByText("Trip completed.")).toBeInTheDocument();
    expect(screen.getByText("Request another trip")).toBeInTheDocument();
  });

  it("'cancelled' with reason 'no_drivers_available' shows that exact honest reason, as an alert", () => {
    renderPanel({ tracking: { status: "cancelled", cancellationReason: "no_drivers_available" } });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("No drivers are online nearby right now.");
    expect(screen.getByText("Request another trip")).toBeInTheDocument();
  });

  it("'cancelled' with reason 'all_candidates_declined' shows a DIFFERENT honest reason, not the same generic text", () => {
    renderPanel({ tracking: { status: "cancelled", cancellationReason: "all_candidates_declined" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Nearby drivers were asked but none accepted.");
  });

  it("'cancelled' with no reason yet (null) shows an honest 'reason unknown' fallback, not a guess", () => {
    renderPanel({ tracking: { status: "cancelled", cancellationReason: null } });
    expect(screen.getByRole("alert")).toHaveTextContent("This trip was cancelled.");
  });
});

describe("TripTrackingPanel: fare estimate — present vs. genuinely absent", () => {
  it("shows the real fare total and surge multiplier when fareEstimate is present", () => {
    renderPanel({
      trip: {
        fareEstimate: {
          currency: "USD",
          baseCents: 250,
          distanceCents: 2014,
          timeCents: 699,
          subtotalCents: 2964,
          surgeMultiplier: 3,
          totalCents: 8892,
        },
      },
    });
    expect(screen.getByText("$88.92")).toBeInTheDocument();
    expect(screen.getByText("×3")).toBeInTheDocument();
    expect(screen.queryByText("Fare estimate isn't available for this trip.")).not.toBeInTheDocument();
  });

  it("shows an honest, permanent message — not a spinner — when fareEstimate is genuinely absent", () => {
    renderPanel({ trip: { fareEstimate: undefined } });
    expect(screen.getByText("Fare estimate isn't available for this trip.")).toBeInTheDocument();
    expect(screen.queryByText("Fare total")).not.toBeInTheDocument();
  });
});

describe("TripTrackingPanel: connection state visibility", () => {
  it("shows nothing extra when connected (silence is correct for the common case)", () => {
    renderPanel({ connectionState: "connected" });
    expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument();
  });

  it("shows a visible reconnecting banner when the WS connection drops", () => {
    renderPanel({ connectionState: "reconnecting" });
    expect(screen.getByText(/Reconnecting… your connection was interrupted\./)).toBeInTheDocument();
  });
});
