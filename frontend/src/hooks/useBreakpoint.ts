import { useEffect, useState } from "react";

export type Breakpoint = "phone" | "tablet" | "desktop";

/** Mirrors Tailwind's own default `sm`/`lg` breakpoints (640px/1024px) — see ui.ts for why these
 * exact numbers were chosen as this project's phone/tablet/desktop tiers
 * (docs/frontend-responsive.md). Kept as plain numbers here (not re-imported from Tailwind, which
 * has no JS-facing export of its breakpoint values) so this hook's behavior is traceable to one
 * pair of literal numbers, matching the same pair the `sm:`/`lg:` utility classes use. */
const TABLET_MIN_PX = 640;
const DESKTOP_MIN_PX = 1024;

function classify(width: number): Breakpoint {
  if (width >= DESKTOP_MIN_PX) return "desktop";
  if (width >= TABLET_MIN_PX) return "tablet";
  return "phone";
}

/**
 * The one place a *structural* layout choice (not just a Tailwind `sm:`/`lg:` style tweak) reads
 * the viewport width — e.g. "render a BottomSheet" vs. "render a side panel next to the map"
 * (Frontend Phase 7, docs/frontend-responsive.md). Deliberately used sparingly: most of this
 * project's responsive behavior is still plain Tailwind responsive classes (cheaper, no JS, no
 * resize listener) — this hook exists only where two *structurally different* trees need
 * rendering, not merely restyled, since CSS alone can't choose between two different component
 * subtrees without mounting both (and mounting both means duplicate interactive controls in the
 * DOM — actionable to a mouse/CSS but confusing to keyboard/assistive tech and test automation
 * alike, which is exactly what this hook avoids).
 */
export function useBreakpoint(): Breakpoint {
  const [breakpoint, setBreakpoint] = useState<Breakpoint>(() =>
    classify(typeof window === "undefined" ? DESKTOP_MIN_PX : window.innerWidth),
  );

  useEffect(() => {
    function handleResize(): void {
      setBreakpoint(classify(window.innerWidth));
    }
    window.addEventListener("resize", handleResize);
    handleResize();
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return breakpoint;
}
