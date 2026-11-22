import type { CameraSpan, Plan } from "./compile.js";
import type { Rect, Us } from "./types.js";

/**
 * The smooth zoom camera. A pure function of time:
 *
 *   cameraAt(plan, t) -> { cx, cy, scale }
 *
 * cx and cy are the centre of the view as fractions of the picture (0..1) and
 * scale is how far in it is (1 = whole picture). Preview and export both call
 * this, so they cannot disagree.
 *
 * Motion rules:
 *  - scale moves in log space, so the zoom feels the same speed throughout;
 *  - the centre is tied to the scale, so the picture heads straight at the
 *    target with no sideways swing;
 *  - timing is a quintic ease: no jolt at the start or the end;
 *  - a move starts from wherever the camera is, so back-to-back zooms glide
 *    from one target to the next without returning to the full picture.
 */
export interface Cam {
  cx: number;
  cy: number;
  scale: number;
}

export interface Move {
  startUs: Us;
  durUs: Us;
  target: Cam;
}

export const HOME: Cam = { cx: 0.5, cy: 0.5, scale: 1 };
/** Extra room kept around a zoom rectangle, as a fraction of its size on each side. */
export const ZOOM_PADDING = 0.12;

/** Quintic smootherstep: 0 to 1 with zero speed and zero acceleration at both ends. */
export function ease(u: number): number {
  const x = Math.min(1, Math.max(0, u));
  return x * x * x * (x * (6 * x - 15) + 10);
}

/** The camera p of the way from a to b (p already eased). */
export function blend(a: Cam, b: Cam, p: number): Cam {
  if (Math.abs(Math.log(b.scale / a.scale)) < 1e-6) {
    return { cx: a.cx + (b.cx - a.cx) * p, cy: a.cy + (b.cy - a.cy) * p, scale: a.scale };
  }
  const scale = a.scale * Math.pow(b.scale / a.scale, p);
  const w = (1 - a.scale / scale) / (1 - a.scale / b.scale);
  return { cx: a.cx + (b.cx - a.cx) * w, cy: a.cy + (b.cy - a.cy) * w, scale };
}

/** Keeps the view inside the picture. */
export function clampCam(c: Cam): Cam {
  const half = 0.5 / c.scale;
  return { cx: Math.min(Math.max(c.cx, half), 1 - half), cy: Math.min(Math.max(c.cy, half), 1 - half), scale: c.scale };
}

/** The camera that shows a rectangle (fractions of the picture) with padding, kept inside the frame. */
export function rectToCamera(rect: Rect, maxScale: number, padding = ZOOM_PADDING): Cam {
  const [x, y, rw, rh] = rect;
  const w = rw * (1 + 2 * padding);
  const h = rh * (1 + 2 * padding);
  const scale = Math.min(maxScale, Math.max(1, Math.min(1 / w, 1 / h)));
  return clampCam({ cx: x + rw / 2, cy: y + rh / 2, scale });
}

/** Turns zoom spans into camera moves. The picture is fully in at a span's start and begins leaving at its end. */
export function planMoves(spans: CameraSpan[]): Move[] {
  const sorted = [...spans].sort((a, b) => a.tlStartUs - b.tlStartUs);
  const moves: Move[] = [];
  sorted.forEach((z, i) => {
    let begin = z.tlStartUs - z.inUs;
    const prev = moves[moves.length - 1];
    if (prev) begin = Math.max(begin, prev.startUs + 50_000);
    moves.push({ startUs: begin, durUs: Math.max(1000, z.tlStartUs - begin), target: rectToCamera(z.rect, z.maxScale) });
    const next = sorted[i + 1];
    // If the next zoom begins before we would be back home, skip the trip home.
    if (!next || next.tlStartUs - next.inUs >= z.tlEndUs + z.outUs) {
      moves.push({ startUs: z.tlEndUs, durUs: Math.max(1000, z.outUs), target: HOME });
    }
  });
  return moves;
}

export function cameraAtMoves(moves: Move[], tUs: Us): Cam {
  let cam = HOME;
  for (const m of moves) {
    if (tUs <= m.startUs) break;
    cam = blend(cam, m.target, ease((tUs - m.startUs) / m.durUs));
  }
  return clampCam(cam);
}

const cache = new WeakMap<Plan, Move[]>();
export function movesOf(plan: Plan): Move[] {
  let moves = cache.get(plan);
  if (!moves) {
    moves = planMoves(plan.camera);
    cache.set(plan, moves);
  }
  return moves;
}

/** The camera at a timeline time. */
export function cameraAt(plan: Plan, tlUs: Us): Cam {
  return plan.camera.length ? cameraAtMoves(movesOf(plan), tlUs) : HOME;
}

/**
 * A stretch of time during which the camera is described by one start state
 * and a fixed list of moves in progress. Export renders one such piece at a time.
 */
export interface CameraPiece {
  startUs: Us;
  endUs: Us;
  /** Where the camera is before the moves below are applied. */
  base: Cam;
  /** Moves that are under way at some point in this piece, in order. */
  moves: Move[];
  /** True when nothing moves and the camera is home: the piece needs no camera work. */
  still: boolean;
}

/** Cuts [fromUs, toUs) wherever a move starts or ends. */
export function cameraPieces(moves: Move[], fromUs: Us, toUs: Us): CameraPiece[] {
  const marks = new Set<Us>([fromUs, toUs]);
  for (const m of moves) {
    for (const t of [m.startUs, m.startUs + m.durUs]) if (t > fromUs && t < toUs) marks.add(t);
  }
  const times = [...marks].sort((a, b) => a - b);
  const pieces: CameraPiece[] = [];
  for (let i = 0; i + 1 < times.length; i++) {
    const a = times[i]!;
    const b = times[i + 1]!;
    // A finished move leaves the camera exactly on its target, whatever came before it.
    let base = HOME;
    let firstLive = 0;
    moves.forEach((m, k) => {
      if (m.startUs + m.durUs <= a) {
        base = m.target;
        firstLive = k + 1;
      }
    });
    const live = moves.slice(firstLive).filter((m) => m.startUs < b);
    const still = live.length === 0 && Math.abs(base.scale - 1) < 1e-9;
    pieces.push({ startUs: a, endUs: b, base, moves: live, still });
  }
  // Join neighbours that need no camera work, so plain footage stays in long runs.
  const joined: CameraPiece[] = [];
  for (const p of pieces) {
    const last = joined[joined.length - 1];
    if (last && last.still && p.still) last.endUs = p.endUs;
    else joined.push(p);
  }
  return joined;
}
