import { CreateRiderForm } from "../components/CreateRiderForm";
import { TripRequestFlow } from "../components/TripRequestFlow";
import { useRiderIdentity } from "../hooks/useRiderIdentity";
import { TOUCH_TARGET_CLASS } from "../ui";

export function RiderView() {
  const { state, createRider, retryCheck } = useRiderIdentity();

  if (state.status === "checking") {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-gray-600">
        Checking rider…
      </div>
    );
  }

  if (state.status === "needs_rider") {
    return <CreateRiderForm onCreate={createRider} />;
  }

  if (state.status === "check_failed") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p role="alert" className="text-sm text-red-600">
          {state.message}
        </p>
        <button
          type="button"
          onClick={retryCheck}
          className={`rounded border border-gray-300 px-4 text-sm ${TOUCH_TARGET_CLASS}`}
        >
          Retry
        </button>
      </div>
    );
  }

  return <TripRequestFlow riderId={state.riderId} />;
}
