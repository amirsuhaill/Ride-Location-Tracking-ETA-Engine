/**
 * Shared responsive/accessibility conventions (Frontend Phase 7, docs/frontend-responsive.md) —
 * one place every screen pulls these from, so the breakpoint numbers and touch-target size are a
 * single stated decision, not independently re-picked per component.
 *
 * Breakpoints: Tailwind's own defaults (`sm` = 640px, `lg` = 1024px) are used as-is rather than
 * customized, because they already land exactly on this phase's requested three tiers:
 *   - phone:   < 640px   (no `sm:`/`lg:` prefix — the unprefixed, mobile-first base styles)
 *   - tablet:  640–1023px (`sm:` prefix)
 *   - desktop: >= 1024px  (`lg:` prefix, layered on top of `sm:`)
 * No `tailwind.config`/`@theme` override needed — see docs/frontend-responsive.md for what
 * actually changes at each tier (not just spacing/font-size) and why.
 */

/**
 * Minimum touch target: 44x44 CSS px, per Apple's Human Interface Guidelines AND WCAG 2.5.5
 * (Level AAA) — chosen over Material's 48x48dp because this app's real device target (a rider
 * or driver's own phone) skews iOS-first for this project's own testing devices, and 44px is
 * still comfortably within Android's accessibility guidance too (Android's minimum is 48dp, but
 * that's `dp` at typical device density; 44 CSS px is close enough that it isn't a meaningfully
 * worse target there, while exactly matching the stricter of the two named references). Applied
 * as an explicit Tailwind utility (`min-h-11 min-w-11` — Tailwind's `11` spacing step is exactly
 * 2.75rem = 44px at the default 16px root) rather than left to each control's own padding to
 * happen to add up to 44px.
 */
export const TOUCH_TARGET_PX = 44;
export const TOUCH_TARGET_CLASS = "min-h-11 min-w-11";

/** Same visible focus ring used everywhere a custom interactive element needs one (buttons,
 * links, map overlay controls) — keyboard users get one consistent, visible indicator project-wide
 * rather than each component inventing its own. */
export const FOCUS_RING_CLASS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600";

/** A control's own bottom padding/position needs to clear a phone's home indicator/gesture bar —
 * `env(safe-area-inset-bottom)` is 0 on devices without one, so `max()` keeps a sane minimum
 * padding everywhere while adding real inset room only where the OS reports one. Used as a
 * Tailwind arbitrary-value utility (`pb-[value]`) rather than global CSS so it's opt-in exactly
 * where a control actually sits at the bottom edge of the viewport. */
export const SAFE_AREA_BOTTOM_PADDING = "max(0.5rem, env(safe-area-inset-bottom))";
