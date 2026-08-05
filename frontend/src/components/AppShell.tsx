import { NavLink, Outlet } from "react-router-dom";
import { FOCUS_RING_CLASS, SAFE_AREA_BOTTOM_PADDING, TOUCH_TARGET_CLASS } from "../ui";
import { HealthIndicator } from "./HealthIndicator";
import { NetworkStatusBanner } from "./NetworkStatusBanner";

const NAV_ITEMS = [
  { to: "/", label: "Rider", icon: "🚕", end: true },
  { to: "/driver", label: "Driver", icon: "🚗", end: false },
  { to: "/dispatcher", label: "Dispatcher", icon: "🗺️", end: false },
] as const;

function linkClasses(isActive: boolean, extra: string): string {
  return [extra, FOCUS_RING_CLASS, isActive ? "text-blue-600 font-semibold" : "text-gray-600"].join(" ");
}

/**
 * Responsive shell: a top nav bar above the `sm` breakpoint (640px), a bottom tab bar below it —
 * chosen to be exactly this project's own documented "phone width" threshold (see
 * docs/frontend-shell.md, docs/frontend-responsive.md), so the breakpoint used here is the same
 * one the acceptance criteria's own phone/desktop test widths were chosen against, not an
 * independently-picked number that happens to roughly line up.
 *
 * The bottom tab bar's own bottom padding uses `env(safe-area-inset-bottom)` (Frontend Phase 7)
 * — on a phone with a home indicator/gesture bar (notched iPhones, most modern Android), the OS
 * reports a nonzero inset here so the tab bar's real tap targets sit above it instead of getting
 * visually and functionally obscured by it.
 *
 * `NetworkStatusBanner` (Frontend Phase 8) sits above both headers, app-wide — a full network
 * loss (or repeated failure to reach core) is a single condition every screen shares, not
 * something each route should have to detect and render on its own.
 */
export function AppShell() {
  return (
    <div className="flex h-full flex-col">
      <NetworkStatusBanner />

      <header className="hidden items-center justify-between border-b border-gray-200 px-6 py-3 sm:flex">
        <span className="text-lg font-semibold">ride-tracking</span>
        <nav aria-label="Primary">
          <ul className="flex gap-6">
            {NAV_ITEMS.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    linkClasses(isActive, `flex items-center px-2 ${TOUCH_TARGET_CLASS}`)
                  }
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

      <nav
        aria-label="Primary"
        className="flex border-t border-gray-200 sm:hidden"
        style={{ paddingBottom: SAFE_AREA_BOTTOM_PADDING }}
      >
        <ul className="flex w-full">
          {NAV_ITEMS.map((item) => (
            <li key={item.to} className="flex-1">
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  linkClasses(
                    isActive,
                    `flex w-full flex-col items-center justify-center gap-0.5 text-xs ${TOUCH_TARGET_CLASS}`,
                  )
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
