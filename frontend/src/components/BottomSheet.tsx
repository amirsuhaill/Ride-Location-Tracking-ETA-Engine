import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { FOCUS_RING_CLASS, SAFE_AREA_BOTTOM_PADDING, TOUCH_TARGET_CLASS } from "../ui";

// Collapsed height is measured from the actual rendered handle+header content (below), not a
// fixed guess — `header` varies a lot by caller (a one-line status vs. a full trip-offer
// countdown with two buttons), and a fixed pixel budget generous enough for the largest case
// would just look like wasted empty space for the smallest one. This is only a fallback for the
// very first paint, before the real measurement lands.
const FALLBACK_COLLAPSED_HEIGHT_PX = 120;
const EXPANDED_HEIGHT_FRACTION = 0.7; // of the positioning parent's own height

export interface BottomSheetProps {
  /** Accessible name for the expand/collapse control, e.g. "Trip details" — never itself
   * rendered as visible text, just what a screen reader announces for the toggle. */
  label: string;
  /** Always visible, in both collapsed and expanded states — the one or two things a phone user
   * needs without any extra gesture (e.g. a time-sensitive accept/decline action, or the current
   * fare total). May contain real interactive controls of its own. */
  header: ReactNode;
  /** Only shown once expanded — supporting detail that doesn't need to be on-screen every second
   * (diagnostics, full coordinates, breakdowns). */
  children: ReactNode;
}

/**
 * Phone-only "trip details" surface (Frontend Phase 7, docs/frontend-responsive.md): map full
 * bleed underneath, this sheet anchored to the bottom of its `relative` positioning parent.
 * Draggable via the handle (pointer events, no library — this project's other custom map
 * interactions are already hand-rolled the same way), snapping to whichever of two states
 * (collapsed/expanded) the drag ended closer to. Also fully keyboard-operable: the handle is a
 * real `<button>` with `aria-expanded`, toggled by a plain click/Enter/Space, plus explicit
 * ArrowUp/ArrowDown to expand/collapse without needing to "hold and drag" at all.
 *
 * `header` sits outside the drag-handle `<button>` (a `<button>` can't legally contain another
 * interactive control) — screens are expected to put anything time-sensitive or primary there
 * (e.g. a trip-offer accept/decline countdown), never behind the extra "expand" step.
 */
export function BottomSheet({ label, header, children }: BottomSheetProps) {
  const [expanded, setExpanded] = useState(false);
  const [dragHeightPx, setDragHeightPx] = useState<number | null>(null);
  const [collapsedHeightPx, setCollapsedHeightPx] = useState(FALLBACK_COLLAPSED_HEIGHT_PX);
  const sheetRef = useRef<HTMLDivElement>(null);
  const collapsedContentRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ startY: number; startHeight: number } | null>(null);

  // Re-measure whenever `header`'s own rendered size changes (a countdown replacing a status
  // line, an error message appearing, etc.), not just once on mount.
  useLayoutEffect(() => {
    const node = collapsedContentRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      setCollapsedHeightPx(node.getBoundingClientRect().height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  function expandedHeightPx(): number {
    const parentHeight = sheetRef.current?.parentElement?.getBoundingClientRect().height;
    return Math.round((parentHeight ?? window.innerHeight) * EXPANDED_HEIGHT_FRACTION);
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLButtonElement>): void {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStartRef.current = {
      startY: e.clientY,
      startHeight: expanded ? expandedHeightPx() : collapsedHeightPx,
    };
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLButtonElement>): void {
    if (!dragStartRef.current) return;
    const draggedUpBy = dragStartRef.current.startY - e.clientY;
    const next = Math.min(
      expandedHeightPx(),
      Math.max(collapsedHeightPx, dragStartRef.current.startHeight + draggedUpBy),
    );
    setDragHeightPx(next);
  }

  function endDrag(): void {
    if (!dragStartRef.current) return;
    const finalHeight = dragHeightPx ?? dragStartRef.current.startHeight;
    const midpoint = (collapsedHeightPx + expandedHeightPx()) / 2;
    setExpanded(finalHeight >= midpoint);
    setDragHeightPx(null);
    dragStartRef.current = null;
  }

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>): void {
    if (e.key === "ArrowUp") {
      setExpanded(true);
      e.preventDefault();
    } else if (e.key === "ArrowDown") {
      setExpanded(false);
      e.preventDefault();
    }
  }

  const height = dragHeightPx ?? (expanded ? expandedHeightPx() : collapsedHeightPx);

  return (
    <div
      ref={sheetRef}
      className="absolute inset-x-0 bottom-0 z-[1000] flex flex-col overflow-hidden rounded-t-xl border-t border-gray-200 bg-white shadow-[0_-2px_16px_rgba(0,0,0,0.18)]"
      style={{ height, transition: dragHeightPx === null ? "height 200ms ease-out" : "none" }}
    >
      <div ref={collapsedContentRef} className="shrink-0">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
          onClick={() => setExpanded((current) => !current)}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={handleKeyDown}
          className={`flex w-full touch-none flex-col items-center justify-center gap-0.5 ${TOUCH_TARGET_CLASS} ${FOCUS_RING_CLASS}`}
        >
          <span aria-hidden="true" className="h-1 w-10 rounded-full bg-gray-300" />
        </button>

        <div className="px-4 pb-2">{header}</div>
      </div>

      {expanded && (
        <div
          className="flex-1 overflow-y-auto px-4"
          style={{ paddingBottom: SAFE_AREA_BOTTOM_PADDING }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
