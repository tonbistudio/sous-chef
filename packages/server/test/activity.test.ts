import { describe, expect, it } from "vitest";
import { groupPointer, pointerMove, type PointerSample } from "../src/activity";

const W = 640;
const H = 360;

/** A grey screen with a small dark arrow-sized mark at (x, y) in pixels. */
function frame(marks: [number, number][], fill = 120): Uint8Array {
  const f = new Uint8Array(W * H).fill(fill);
  for (const [x, y] of marks) {
    for (let dy = 0; dy < 7; dy++) for (let dx = 0; dx < 4; dx++) f[(y + dy) * W + x + dx] = 10;
  }
  return f;
}

describe("pointer", () => {
  it("finds a pointer that moved, between where it was and where it is", () => {
    const m = pointerMove(frame([[100, 100]]), frame([[130, 110]]));
    expect(m.big).toBe(false);
    expect(m.at![0]).toBeCloseTo((101.5 + 131.5) / 2 / W, 2);
    expect(m.at![1]).toBeCloseTo((103 + 113) / 2 / H, 2);
  });

  it("ignores a change bigger than a pointer and flags a whole-screen change", () => {
    const panel = frame([]);
    // A small panel opening: bigger than a pointer, smaller than a whole-screen change.
    for (let y = 50; y < 90; y++) for (let x = 50; x < 80; x++) panel[y * W + x] = 250;
    expect(pointerMove(frame([]), panel)).toEqual({ at: null, big: false });
    expect(pointerMove(frame([]), frame([], 240)).big).toBe(true);
  });

  const at = (t: number, x: number, y: number): PointerSample => ({ t, at: [x, y], big: false });

  it("turns a pointer moving around one area for a few seconds into a target", () => {
    const s: PointerSample[] = [];
    for (let i = 0; i < 14; i++) s.push(at(10 + i * 0.25, 0.4 + 0.05 * Math.sin(i), 0.5 + 0.04 * Math.cos(i)));
    const found = groupPointer(s);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("pointer");
    expect(found[0]!.startUs).toBe(10_000_000);
    const [x, y, w, h] = found[0]!.rect;
    expect(x).toBeLessThan(0.36);
    expect(x + w).toBeGreaterThan(0.44);
    expect(y).toBeLessThan(0.46);
    expect(y + h).toBeGreaterThan(0.54);
  });

  it("leaves out a change that never moves (a blinking caret) and a pointer only passing through", () => {
    const caret: PointerSample[] = [];
    for (let i = 0; i < 20; i++) caret.push(at(i * 0.5, 0.3, 0.3));
    expect(groupPointer(caret)).toHaveLength(0);
    const passing: PointerSample[] = [];
    for (let i = 0; i < 12; i++) passing.push(at(i * 0.25, 0.05 + i * 0.08, 0.5));
    expect(groupPointer(passing)).toHaveLength(0);
  });

  it("ends a stretch when the whole screen changes", () => {
    const s: PointerSample[] = [];
    for (let i = 0; i < 6; i++) s.push(at(i * 0.25, 0.5 + 0.02 * (i % 2), 0.5 + 0.02 * (i % 3)));
    s.push({ t: 1.5, at: null, big: true });
    for (let i = 0; i < 6; i++) s.push(at(1.75 + i * 0.25, 0.5 + 0.02 * (i % 2), 0.5 + 0.02 * (i % 3)));
    // Each half is under two seconds on its own.
    expect(groupPointer(s)).toHaveLength(0);
  });
});
