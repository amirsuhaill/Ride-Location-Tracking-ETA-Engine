import type { DriverStatus } from "./api/types";

/**
 * Mirrors docs/API.md's driver status legal-transition table exactly:
 *
 * | From      | To online | To offline | To busy |
 * | offline   |     ✅     |     —      |    ❌    |
 * | online    |     —     |     ✅      |    ✅    |
 * | busy      |     ✅     |     ❌      |    —    |
 *
 * ("—" = already that status, a no-op 200, not illegal.) Checked client-side purely for instant
 * UI feedback (disabling a button the backend would reject anyway) — core's own PATCH
 * /drivers/:id/status is still the real, enforced source of truth; this never replaces it.
 */
export function canTransitionDriverStatus(from: DriverStatus, to: DriverStatus): boolean {
  if (from === to) return true;
  if (to === "online") return from === "offline" || from === "busy";
  if (to === "offline") return from === "online";
  if (to === "busy") return from === "online";
  return false;
}
