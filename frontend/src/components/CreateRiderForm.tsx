import { useRef, useState } from "react";
import type { CreateRiderOutcome } from "../hooks/useRiderIdentity";
import { TOUCH_TARGET_CLASS } from "../ui";

export interface CreateRiderFormProps {
  onCreate: (name: string) => Promise<CreateRiderOutcome>;
}

/** The minimal "create/select a rider" step (docs/API.md's POST /riders) gating the trip-request
 * flow — so a trip is never requested with a riderId that doesn't exist. */
export function CreateRiderForm({ onCreate }: CreateRiderFormProps) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Synchronous guard against a double-submit outracing React's state update — the same pattern
  // used for the trip-request submit button below.
  const submittingRef = useRef(false);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = name.trim();
    if (submittingRef.current || !trimmed) return;

    submittingRef.current = true;
    setSubmitting(true);
    setErrorMessage(null);

    const outcome = await onCreate(trimmed);

    submittingRef.current = false;
    setSubmitting(false);
    if (!outcome.ok) {
      setErrorMessage(outcome.message ?? "Could not create rider.");
    }
    // On success the parent's identity state flips to "ready" and this component unmounts.
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-3">
        <h1 className="text-lg font-semibold">Welcome</h1>
        <label className="block text-sm text-gray-600" htmlFor="rider-name">
          What should we call you?
        </label>
        <input
          id="rider-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          required
          className={`w-full rounded border border-gray-300 px-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 ${TOUCH_TARGET_CLASS}`}
        />
        {errorMessage && (
          <p role="alert" className="text-sm text-red-600">
            {errorMessage}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting || !name.trim()}
          className={`w-full rounded bg-blue-600 px-4 text-white disabled:opacity-50 ${TOUCH_TARGET_CLASS}`}
        >
          {submitting ? "Creating…" : "Continue"}
        </button>
      </form>
    </div>
  );
}
