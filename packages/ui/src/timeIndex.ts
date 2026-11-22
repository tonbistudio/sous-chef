import type { Plan, Segment } from "@sous-chef/core";

/**
 * Lookups the preview makes on every frame, worked out once per plan instead of scanning every
 * segment 60 times a second: what is on the main track at a moment, what comes next, and which
 * other-track pieces could be showing.
 */
export interface PlanIndex {
  /** Main-track pieces with picture, in timeline order. */
  mainVideo: Segment[];
  /** Every main-track piece, in timeline order (fades to black use these). */
  main: Segment[];
  /** Pieces on the other tracks, in plan order (that is the stacking order). */
  others: Segment[];
}

const cache = new WeakMap<Plan, PlanIndex>();

export function planIndex(plan: Plan): PlanIndex {
  let ix = cache.get(plan);
  if (!ix) {
    const main = plan.segments.filter((s) => s.trackKind === "main").sort((a, b) => a.tlStartUs - b.tlStartUs);
    ix = { main, mainVideo: main.filter((s) => s.hasVideo), others: plan.segments.filter((s) => s.trackKind !== "main") };
    cache.set(plan, ix);
  }
  return ix;
}

/** Index of the first item whose start is after `t` (items sorted by start, not overlapping). */
function upper<T>(items: T[], t: number, start: (x: T) => number): number {
  let lo = 0, hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (start(items[mid]!) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The piece covering `t` in a sorted, non-overlapping list, or null. */
export function pieceAt(items: Segment[], t: number): Segment | null {
  const i = upper(items, t, (s) => s.tlStartUs) - 1;
  const s = i >= 0 ? items[i]! : null;
  return s && t < s.tlEndUs ? s : null;
}

/** The first piece starting at or after `t`, or null. */
export function pieceFrom(items: Segment[], t: number): Segment | null {
  let lo = 0, hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid]!.tlStartUs < t) lo = mid + 1;
    else hi = mid;
  }
  return items[lo] ?? null;
}

/** The item covering `t` in a sorted, non-overlapping list of {startUs, endUs}, or undefined. */
export function cueAt<T extends { startUs: number; endUs: number }>(items: T[], t: number): T | undefined {
  const i = upper(items, t, (c) => c.startUs) - 1;
  const c = i >= 0 ? items[i] : undefined;
  return c && t < c.endUs ? c : undefined;
}
