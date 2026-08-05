import { useRef, useState } from "react";
import type { CreateDriverOutcome } from "../hooks/useDriverIdentity";
import { TOUCH_TARGET_CLASS } from "../ui";

export interface CreateDriverFormProps {
  onCreate: (input: {
    name: string;
    vehicleMake: string;
    vehicleModel: string;
    vehicleColor: string;
    vehiclePlate: string;
  }) => Promise<CreateDriverOutcome>;
}

const FIELDS = [
  { key: "name", label: "Name", placeholder: "Your name" },
  { key: "vehicleMake", label: "Vehicle make", placeholder: "Toyota" },
  { key: "vehicleModel", label: "Vehicle model", placeholder: "Camry" },
  { key: "vehicleColor", label: "Vehicle color", placeholder: "Black" },
  { key: "vehiclePlate", label: "License plate", placeholder: "8ABC123" },
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];

/** The minimal "create/select a driver" step (docs/API.md's POST /drivers) gating the driver
 * dashboard — mirrors CreateRiderForm's shape (Frontend Phase 2), with the extra vehicle fields
 * POST /drivers actually requires. */
export function CreateDriverForm({ onCreate }: CreateDriverFormProps) {
  const [values, setValues] = useState<Record<FieldKey, string>>({
    name: "",
    vehicleMake: "",
    vehicleModel: "",
    vehicleColor: "",
    vehiclePlate: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const submittingRef = useRef(false);

  const allFilled = FIELDS.every((f) => values[f.key].trim().length > 0);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (submittingRef.current || !allFilled) return;

    submittingRef.current = true;
    setSubmitting(true);
    setErrorMessage(null);

    const outcome = await onCreate({
      name: values.name.trim(),
      vehicleMake: values.vehicleMake.trim(),
      vehicleModel: values.vehicleModel.trim(),
      vehicleColor: values.vehicleColor.trim(),
      vehiclePlate: values.vehiclePlate.trim(),
    });

    submittingRef.current = false;
    setSubmitting(false);
    if (!outcome.ok) {
      setErrorMessage(outcome.message ?? "Could not create driver.");
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-3">
        <h1 className="text-lg font-semibold">Driver sign-up</h1>
        {FIELDS.map((field) => (
          <div key={field.key}>
            <label className="block text-sm text-gray-600" htmlFor={field.key}>
              {field.label}
            </label>
            <input
              id={field.key}
              type="text"
              value={values[field.key]}
              onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
              placeholder={field.placeholder}
              required
              className={`mt-1 w-full rounded border border-gray-300 px-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 ${TOUCH_TARGET_CLASS}`}
            />
          </div>
        ))}
        {errorMessage && (
          <p role="alert" className="text-sm text-red-600">
            {errorMessage}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting || !allFilled}
          className={`w-full rounded bg-blue-600 px-4 text-white disabled:opacity-50 ${TOUCH_TARGET_CLASS}`}
        >
          {submitting ? "Creating…" : "Continue"}
        </button>
      </form>
    </div>
  );
}
