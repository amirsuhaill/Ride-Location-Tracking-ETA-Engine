import { NavLink, Outlet } from "react-router-dom";
import { HealthIndicator } from "./HealthIndicator";

const NAV_ITEMS = [
  { to: "/", label: "Rider", icon: "🚕", end: true },
  { to: "/driver", label: "Driver", icon: "🚗", end: false },
  { to: "/dispatcher", label: "Dispatcher", icon: "🗺️", end: false },
] as const;

const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600";

function linkClasses(isActive: boolean, extra: string): string {
  return [extra, FOCUS_RING, isActive ? "text-blue-600 font-semibold" : "text-gray-600"].join(" ");
}

/**
 * Responsive shell: a top nav bar above the `sm` breakpoint (640px), a bottom tab bar below it —
 * chosen to be exactly this project's own documented "phone width" threshold (see
 * docs/frontend-shell.md), so the breakpoint used here is the same one the acceptance criteria's
 * own phone/desktop test widths were chosen against, not an independently-picked number that
 * happens to roughly line up.
 */
export function AppShell() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="hidden items-center justify-between border-b border-gray-200 px-6 py-3 sm:flex">
        <span className="text-lg font-semibold">ride-tracking</span>
        <nav aria-label="Primary">
          <ul className="flex gap-6">
            {NAV_ITEMS.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => linkClasses(isActive, "px-1 py-1")}
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <HealthIndicator />
      </header>

      <header className="flex items-center justify-between border-b border-gray-200 px-4 py-3 sm:hidden">
        <span className="text-base font-semibold">ride-tracking</span>
        <HealthIndicator />
      </header>

      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>

      <nav aria-label="Primary" className="flex border-t border-gray-200 sm:hidden">
        <ul className="flex w-full">
          {NAV_ITEMS.map((item) => (
            <li key={item.to} className="flex-1">
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  linkClasses(isActive, "flex flex-col items-center gap-0.5 py-2 text-xs w-full")
                }
              >
                <span aria-hidden="true" className="text-lg leading-none">
                  {item.icon}
                </span>
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
