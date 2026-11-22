import { describe, expect, it } from "vitest";
import { blend, cameraAtMoves, cameraPieces, ease, HOME, planMoves, rectToCamera, type CameraSpan } from "../src/index";

const S = 1_000_000;
const W = 1920;
const H = 1080;
const px = (x: number, y: number, w: number, h: number): [number, number, number, number] => [x / W, y / H, w / W, h / H];
const span = (start: number, end: number, rect: ReturnType<typeof px>, id = "z"): CameraSpan => ({ zoomId: id, tlStartUs: start * S, tlEndUs: end * S, rect, inUs: 1.5 * S, outUs: 1.5 * S, maxScale: 2.5 });
// The same three zooms the prototype was tested with.
const SPANS = [span(5, 9, px(582, 660, 360, 200)), span(10, 14, px(1400, 100, 400, 220)), span(30, 34, px(0, 0, 300, 200))];
const moves = planMoves(SPANS);
const path = Array.from({ length: 40 * 60 }, (_, i) => cameraAtMoves(moves, Math.round((i / 60) * S)));

describe("smooth zoom camera", () => {
  it("eases from 0 to 1 through one half", () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeCloseTo(0.5, 12);
  });

  it("reaches the target exactly when the zoom starts, and returns home", () => {
    const t = rectToCamera(SPANS[0]!.rect, 2.5);
    const c = cameraAtMoves(moves, 5 * S);
    expect(c.scale).toBeCloseTo(t.scale, 6);
    expect(c.cx).toBeCloseTo(t.cx, 6);
    expect(cameraAtMoves(moves, 0)).toEqual(HOME);
    const end = cameraAtMoves(moves, 40 * S);
    expect(end.scale).toBeCloseTo(1, 9);
    expect(end.cx).toBeCloseTo(0.5, 6);
  });

  it("matches the prototype's numbers for the first target", () => {
    // rect_to_camera([582,660,360,200], 1920, 1080) in the Python prototype: scale 2.5, centre (762, 760).
    const t = rectToCamera(SPANS[0]!.rect, 2.5);
    expect(t.scale).toBeCloseTo(2.5, 9);
    expect(t.cx * W).toBeCloseTo(762, 6);
    expect(t.cy * H).toBeCloseTo(760, 6);
  });

  it("never shows outside the picture", () => {
    for (const c of path) {
      const half = 0.5 / c.scale;
      expect(c.cx - half).toBeGreaterThanOrEqual(-1e-9);
      expect(c.cx + half).toBeLessThanOrEqual(1 + 1e-9);
      expect(c.cy - half).toBeGreaterThanOrEqual(-1e-9);
      expect(c.cy + half).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("has no jumps or jolts", () => {
    const ls = path.map((c) => Math.log(c.scale));
    const v = ls.slice(1).map((x, i) => x - ls[i]!);
    const acc = v.slice(1).map((x, i) => x - v[i]!);
    expect(Math.max(...v.map(Math.abs))).toBeLessThan(0.02);
    expect(Math.max(...acc.map(Math.abs))).toBeLessThan(0.001);
    expect(Math.max(...path.slice(1).map((c, i) => Math.abs(c.cx - path[i]!.cx) * W))).toBeLessThan(25);
  });

  it("stays zoomed in between back-to-back zooms", () => {
    const scales = Array.from({ length: 60 }, (_, i) => cameraAtMoves(moves, Math.round((9 + i / 60) * S)).scale);
    expect(Math.min(...scales)).toBeGreaterThan(1.5);
  });

  it("heads straight at the target", () => {
    const a = { cx: 0.5, cy: 0.5, scale: 1 };
    const b = { cx: 700 / W, cy: 760 / H, scale: 2 };
    const d = Array.from({ length: 101 }, (_, i) => {
      const c = blend(a, b, i / 100);
      return Math.hypot((b.cx - c.cx) * W * c.scale, (b.cy - c.cy) * H * c.scale);
    });
    for (let i = 1; i < d.length; i++) expect(d[i]!).toBeLessThanOrEqual(d[i - 1]! + 1e-9);
  });

  it("splits time into pieces that reproduce the same camera", () => {
    const pieces = cameraPieces(moves, 0, 40 * S);
    expect(pieces[0]).toMatchObject({ startUs: 0, endUs: 3.5 * S, still: true });
    expect(pieces[pieces.length - 1]!.still).toBe(true);
    // Pieces tile the range with no gap or overlap.
    for (let i = 1; i < pieces.length; i++) expect(pieces[i]!.startUs).toBe(pieces[i - 1]!.endUs);
    // Replaying a piece from its base and live moves gives the true camera.
    for (const p of pieces) {
      for (const t of [p.startUs + 1, Math.floor((p.startUs + p.endUs) / 2), p.endUs - 1]) {
        let cam = p.base;
        for (const m of p.moves) if (t > m.startUs) cam = blend(cam, m.target, ease((t - m.startUs) / m.durUs));
        const truth = cameraAtMoves(moves, t);
        expect(cam.scale).toBeCloseTo(truth.scale, 9);
        expect(cam.cx).toBeCloseTo(truth.cx, 6);
        expect(cam.cy).toBeCloseTo(truth.cy, 6);
      }
    }
  });
});
