import { CreateDriverForm } from "../components/CreateDriverForm";
import { DriverDashboard } from "../components/DriverDashboard";
import { useDriverIdentity } from "../hooks/useDriverIdentity";
import { TOUCH_TARGET_CLASS } from "../ui";

export function DriverView() {
  const { state, createDriver, refresh } = useDriverIdentity();

  if (state.status === "checking") {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-gray-600">
        Checking driver…
      </div>
    );
  }

  if (state.status === "needs_driver") {
    return <CreateDriverForm onCreate={createDriver} />;
  }

  if (state.status === "check_failed") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p role="alert" className="text-sm text-red-600">
          {state.message}
        </p>
        <button
          type="button"
          onClick={refresh}
          className={`rounded border border-gray-300 px-4 text-sm ${TOUCH_TARGET_CLASS}`}
        >
          Retry
        </button>
      </div>
    );
  }

  return <DriverDashboard driver={state.driver} />;
}
