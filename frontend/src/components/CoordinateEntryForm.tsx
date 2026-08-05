import { useId, useState, type FormEvent } from "react";
import type { LatLng } from "../api/types";
import { validate } from "../coordinateValidation";
import { FOCUS_RING_CLASS, TOUCH_TARGET_CLASS } from "../ui";

export interface CoordinateEntryFormProps {
  /** Both the collapsed toggle button's visible text and the expanded form's accessible name —
   * e.g. "Set pickup by coordinates". */
  label: string;
  onSubmit: (point: LatLng) => void;
}

/**
 * A fully keyboard-operable alternative to tapping/dragging the map (Frontend Phase 7's
 * keyboard-navigation pass — docs/frontend-responsive.md). Leaflet's click/drag interactions have
 * no built-in keyboard equivalent, and giving the map canvas itself real arrow-key-driven focus
 * semantics would be a much larger, riskier undertaking for a "basic pass"; a plain Tab-reachable
 * form that calls the exact same `onSetPickup`/`onSetDropoff`/`onManualSet` callback a map
 * tap/drag would have is a fully equivalent, much simpler path to "reachable and operable without
 * a mouse."
 */
export function CoordinateEntryForm({ label, onSubmit }: CoordinateEntryFormProps) {
  const [open, setOpen] = useState(false);
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [error, setError] = useState<string | null>(null);
  const latId = useId();
  const lngId = useId();
  const errorId = useId();

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    const message = validate(lat, lng);
    if (message) {
      setError(message);
      return;
    }
    setError(null);
    onSubmit({ lat: Number(lat), lng: Number(lng) });
    setOpen(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`rounded bg-white px-3 text-xs text-gray-700 shadow ${TOUCH_TARGET_CLASS} ${FOCUS_RING_CLASS}`}
      >
        ⌨ {label}
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-label={label}
      className="flex flex-col gap-2 rounded bg-white p-3 text-xs shadow"
    >
      <div className="flex items-center gap-2">
        <label htmlFor={latId} className="w-10">
          Lat
        </label>
        <input
          id={latId}
          type="number"
          step="any"
          value={lat}
          onChange={(e) => setLat(e.target.value)}
          required
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          className={`w-full min-w-0 rounded border border-gray-300 px-2 ${TOUCH_TARGET_CLASS} ${FOCUS_RING_CLASS}`}
        />
      </div>
      <div className="flex items-center gap-2">
        <label htmlFor={lngId} className="w-10">
          Lng
        </label>
        <input
          id={lngId}
          type="number"
          step="any"
          value={lng}
          onChange={(e) => setLng(e.target.value)}
          required
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          className={`w-full min-w-0 rounded border border-gray-300 px-2 ${TOUCH_TARGET_CLASS} ${FOCUS_RING_CLASS}`}
        />
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-red-600">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          className={`flex-1 rounded bg-blue-600 px-2 text-white ${TOUCH_TARGET_CLASS} ${FOCUS_RING_CLASS}`}
        >
          Set
        </button>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setOpen(false);
          }}
          className={`flex-1 rounded border border-gray-300 px-2 ${TOUCH_TARGET_CLASS} ${FOCUS_RING_CLASS}`}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
