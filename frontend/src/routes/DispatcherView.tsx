import { useState } from "react";
import { DriverMap } from "../components/DriverMap";

export function DispatcherView() {
  const [trackedDriverId, setTrackedDriverId] = useState<string | null>(null);

  return (
    <div className="h-full w-full">
      <DriverMap trackedDriverId={trackedDriverId} onSelectDriver={setTrackedDriverId} />
    </div>
  );
}
