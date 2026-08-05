import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { RiderView } from "./routes/RiderView";
import { DriverView } from "./routes/DriverView";
import { DispatcherView } from "./routes/DispatcherView";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<RiderView />} />
          <Route path="/driver" element={<DriverView />} />
          <Route path="/dispatcher" element={<DispatcherView />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
