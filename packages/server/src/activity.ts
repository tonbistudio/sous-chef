import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Rect } from "@sous-chef/core";
import type { JobHandle } from "./jobs.js";

/**
 * Finds where on the screen things are happening, so zooms have something to
 * aim at. Screen recordings have no cursor data, so this looks at the picture:
 * it compares small greyscale frames a quarter of a second apart and notes the
 * moments when the change is confined to one part of the screen (typing, a
 * panel updating, a menu opening). Whole-screen changes such as scrolling or
 * switching windows are ignored.
 *
 * The mouse pointer is found the same way, at twice the size: as it moves it
 * leaves a pair of tiny changes (where it was, where it is). A stretch where
 * the pointer keeps moving around one area, the way someone points at what they
 * are talking about, is a target too. Tiny changes that never move (a blinking
 * caret, a spinner, a clock) are not a pointer and are left out.
 *
 * This is original work for Sous Chef; it shares no code with other tools.
 */
export interface Activity {
  startUs: number;
  endUs: number;
  /** Where the change is, as fractions of the picture: left, top, width, height. */
  rect: Rect;
  /** 0..1: how confined and sustained the change is. */
  score: number;
  /** What was seen: part of the screen changing, or the pointer moving around one area. */
  kind?: "change" | "pointer";
}

const W = 320;
const H = 180;
const STEP_S = 0.25;
/** A pixel counts as changed when its brightness moves by more than this (0..255). */
const PIXEL = 22;
/** Fewer changed pixels than this is noise or just the mouse pointer. */
const MIN_CHANGED = 0.0006;
/** More than this is a scroll or a window switch, not something to zoom into. */
const MAX_CHANGED = 0.14;
const MAX_AREA = 0.34;
/** Frames this far apart still belong to the same burst of activity. */
const JOIN_S = 1.6;
const MIN_LEN_S = 1.5;

interface Sample {
  t: number;
  changed: number;
  box: [number, number, number, number] | null;
}

/** The pointer scan works on frames twice the size of the change scan. */
const PW = W * 2;
const PH = H * 2;
const P_PIXEL = 28;
/** More changed pixels than this (at PW x PH) is more than a pointer moving. */
const P_MAX_CHANGED = 2500;

export interface PointerSample {
  t: number;
  /** Middle of the tiny changes, as fractions of the picture; null when there were none or the change was big. */
  at: [number, number] | null;
  /** The screen changed a lot: whatever the pointer was doing has ended. */
  big: boolean;
}

/**
 * Where a pointer could have moved between two frames: the middle of the small separate groups of
 * changed pixels, each about the size of a pointer. Null when the change is anything else.
 */
export function pointerMove(a: Uint8Array, b: Uint8Array, w = PW, h = PH): { at: [number, number] | null; big: boolean } {
  const size = w * h;
  const mask = new Uint8Array(size);
  let changed = 0;
  for (let i = 0; i < size; i++) {
    const d = a[i]! - b[i]!;
    if (d > P_PIXEL || d < -P_PIXEL) {
      mask[i] = 1;
      changed++;
    }
  }
  if (changed === 0) return { at: null, big: false };
  if (changed > P_MAX_CHANGED) return { at: null, big: true };
  // Groups of changed pixels; pixels up to two apart join, so a pointer's outline is one group.
  const stack: number[] = [];
  let sx = 0, sy = 0, groups = 0;
  for (let i = 0; i < size; i++) {
    if (!mask[i]) continue;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, n = 0;
    mask[i] = 0;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % w;
      const y = (j / w) | 0;
      n++;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const k = yy * w + xx;
          if (mask[k]) {
            mask[k] = 0;
            stack.push(k);
          }
        }
      }
    }
    const gw = x1 - x0 + 1;
    const gh = y1 - y0 + 1;
    // Anything bigger than a pointer means something else changed too.
    if (gw > 16 || gh > 20 || n > 160) return { at: null, big: false };
    if (n < 8) continue;
    if (++groups > 3) return { at: null, big: false };
    sx += (x0 + x1) / 2;
    sy += (y0 + y1) / 2;
  }
  return groups ? { at: [sx / groups / w, sy / groups / h], big: false } : { at: null, big: false };
}

/** Area a pointer is moving around in counts if it is no bigger than this, as a fraction of each side. */
const POINT_SPAN = 0.3;
const POINT_MIN_S = 2;
const POINT_JOIN_S = 1;

/** Stretches where the pointer keeps moving around one area. */
export function groupPointer(samples: PointerSample[]): Activity[] {
  const out: Activity[] = [];
  let cur: PointerSample[] = [];
  const close = () => {
    if (cur.length >= 5) {
      const first = cur[0]!.t;
      const last = cur[cur.length - 1]!.t;
      const lenS = last - first + STEP_S;
      const xs = cur.map((s) => s.at![0]).sort((p, q) => p - q);
      const ys = cur.map((s) => s.at![1]).sort((p, q) => p - q);
      const q = (v: number[], f: number) => v[Math.min(v.length - 1, Math.max(0, Math.round(f * (v.length - 1))))]!;
      const x0 = q(xs, 0.05), x1 = q(xs, 0.95), y0 = q(ys, 0.05), y1 = q(ys, 0.95);
      // It has to wander: a change that stays on one spot is a caret, a spinner or a clock, not a hand on a mouse.
      const moved = x1 - x0 > 0.015 || y1 - y0 > 0.015;
      const cells = new Map<string, number>();
      for (const s of cur) {
        const key = `${Math.round(s.at![0] * 60)}:${Math.round(s.at![1] * 34)}`;
        cells.set(key, (cells.get(key) ?? 0) + 1);
      }
      const anchored = Math.max(...cells.values()) > cur.length * 0.6;
      if (lenS >= POINT_MIN_S && moved && !anchored) {
        // Room around where it moved, so what it points at is in the picture.
        const padX = 0.04, padY = 0.06;
        const rx = Math.max(0, x0 - padX), ry = Math.max(0, y0 - padY);
        const rect = [rx, ry, Math.min(1, x1 + padX) - rx, Math.min(1, y1 + padY) - ry].map((v) => Math.round(v * 1000) / 1000) as Rect;
        const steady = cur.length / (lenS / STEP_S);
        // Along the very edge of the screen the pointer is usually on its way somewhere (a side bar, the taskbar).
        const edge = x0 < 0.02 || x1 > 0.98 || y1 > 0.97 ? 0.15 : 0;
        const score = Math.max(0, Math.min(1, 0.38 + Math.min(1, lenS / 6) * 0.2 + steady * 0.15 + (1 - (rect[2] * rect[3]) / (POINT_SPAN * POINT_SPAN)) * 0.1 - edge));
        out.push({ startUs: Math.round(first * 1e6), endUs: Math.round((last + STEP_S) * 1e6), rect, score: Math.round(score * 100) / 100, kind: "pointer" });
      }
    }
    cur = [];
  };
  for (const s of samples) {
    if (s.big) {
      close();
      continue;
    }
    if (!s.at) continue;
    const prev = cur[cur.length - 1];
    if (prev && s.t - prev.t > POINT_JOIN_S) close();
    if (cur.length) {
      // Still within one area? Measured against everything in the stretch so far.
      const xs = cur.map((c) => c.at![0]).concat(s.at[0]);
      const ys = cur.map((c) => c.at![1]).concat(s.at[1]);
      if (Math.max(...xs) - Math.min(...xs) > POINT_SPAN || Math.max(...ys) - Math.min(...ys) > POINT_SPAN) close();
    }
    cur.push(s);
  }
  close();
  return out;
}

/** Compares two frames. The box ignores the outermost 4% of changed pixels so one stray pixel cannot stretch it. */
export function diffFrames(a: Uint8Array, b: Uint8Array, w = W, h = H): { changed: number; box: [number, number, number, number] | null } {
  const cols = new Uint32Array(w);
  const rows = new Uint32Array(h);
  let n = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const d = a[row + x]! - b[row + x]!;
      if (d > PIXEL || d < -PIXEL) {
        cols[x]!++;
        rows[y]!++;
        n++;
      }
    }
  }
  if (n === 0) return { changed: 0, box: null };
  const edge = (hist: Uint32Array, fromStart: boolean): number => {
    const skip = n * 0.02;
    let acc = 0;
    if (fromStart) {
      for (let i = 0; i < hist.length; i++) {
        acc += hist[i]!;
        if (acc > skip) return i;
      }
      return 0;
    }
    for (let i = hist.length - 1; i >= 0; i--) {
      acc += hist[i]!;
      if (acc > skip) return i;
    }
    return hist.length - 1;
  };
  return { changed: n / (w * h), box: [edge(cols, true), edge(rows, true), edge(cols, false) + 1, edge(rows, false) + 1] };
}

/** Groups per-frame changes into bursts of confined activity. */
export function groupActivity(samples: Sample[], w = W, h = H): Activity[] {
  const out: Activity[] = [];
  let run: Sample[] = [];
  const flush = () => {
    if (run.length >= 2) {
      const first = run[0]!;
      const last = run[run.length - 1]!;
      const len = last.t - first.t + STEP_S;
      if (len >= MIN_LEN_S) {
        // The middle 90% of the boxes, so one odd frame cannot stretch the target.
        const pick = (i: number, low: boolean) => {
          const v = run.map((s) => s.box![i]!).sort((p, q) => p - q);
          return v[Math.min(v.length - 1, Math.max(0, Math.round((low ? 0.05 : 0.95) * (v.length - 1))))]!;
        };
        const x0 = pick(0, true);
        const y0 = pick(1, true);
        const x1 = pick(2, false);
        const y1 = pick(3, false);
        const area = ((x1 - x0) * (y1 - y0)) / (w * h);
        if (area > 0 && area <= MAX_AREA) {
          const busy = run.length / (len / STEP_S);
          const score = Math.max(0, Math.min(1, (1 - area / MAX_AREA) * 0.6 + Math.min(1, len / 6) * 0.25 + busy * 0.15));
          out.push({
            startUs: Math.round(first.t * 1e6),
            endUs: Math.round((last.t + STEP_S) * 1e6),
            rect: [x0 / w, y0 / h, (x1 - x0) / w, (y1 - y0) / h].map((v) => Math.round(v * 1000) / 1000) as Rect,
            score: Math.round(score * 100) / 100,
            kind: "change",
          });
        }
      }
    }
    run = [];
  };
  for (const s of samples) {
    const confined = s.box !== null && s.changed >= MIN_CHANGED && s.changed <= MAX_CHANGED && ((s.box[2] - s.box[0]) * (s.box[3] - s.box[1])) / (w * h) <= MAX_AREA;
    if (s.changed > MAX_CHANGED) {
      // The whole screen changed: whatever was going on has ended.
      flush();
      continue;
    }
    if (!confined) continue;
    const last = run[run.length - 1];
    if (last) {
      // A burst that jumps to a different part of the screen is a new burst.
      const far = Math.abs((s.box![0] + s.box![2]) / 2 - (last.box![0] + last.box![2]) / 2) > w * 0.3 || Math.abs((s.box![1] + s.box![3]) / 2 - (last.box![1] + last.box![3]) / 2) > h * 0.3;
      if (s.t - last.t > JOIN_S || far) flush();
    }
    run.push(s);
  }
  flush();
  return out;
}

/** Halves a greyscale frame in each direction (2x2 average). */
function half(f: Uint8Array, w: number, h: number): Uint8Array {
  const hw = w >> 1;
  const hh = h >> 1;
  const out = new Uint8Array(hw * hh);
  for (let y = 0; y < hh; y++) {
    const r0 = 2 * y * w;
    const r1 = r0 + w;
    for (let x = 0; x < hw; x++) out[y * hw + x] = (f[r0 + 2 * x]! + f[r0 + 2 * x + 1]! + f[r1 + 2 * x]! + f[r1 + 2 * x + 1]! + 2) >> 2;
  }
  return out;
}

/** Reads a file as small greyscale frames and returns the bursts of confined activity and pointing in it. */
export async function detectActivity(file: string, handle: JobHandle | null, durationUs: number, onProgress?: (p: number) => void): Promise<Activity[]> {
  const samples: Sample[] = [];
  const pointer: PointerSample[] = [];
  const size = PW * PH;
  let prevFull: Uint8Array | null = null;
  let prev: Uint8Array | null = null;
  let carry: Buffer = Buffer.alloc(0);
  let index = 0;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-reinit_filter", "0", "-i", file, "-an", "-vf", `fps=${1 / STEP_S},scale=${PW}:${PH}:flags=area,format=gray`, "-f", "rawvideo", "pipe:1"],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    if (handle) handle.onCancel = () => child.kill();
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err = (err + d.toString("utf8")).slice(-2000)));
    child.stdout.on("data", (chunk: Buffer) => {
      let buf: Buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      while (buf.length >= size) {
        const full = new Uint8Array(buf.subarray(0, size));
        buf = buf.subarray(size);
        const frame = half(full, PW, PH);
        if (prev && prevFull) {
          const d = diffFrames(prev, frame);
          samples.push({ t: index * STEP_S, changed: d.changed, box: d.box });
          pointer.push({ t: index * STEP_S, ...pointerMove(prevFull, full) });
        }
        prev = frame;
        prevFull = full;
        index++;
        if (index % 40 === 0 && durationUs > 0) onProgress?.(Math.min(1, (index * STEP_S * 1e6) / durationUs));
      }
      carry = buf;
    });
    child.on("error", (e) => reject(new Error(`Could not run ffmpeg: ${e.message}`)));
    child.on("close", (code) => {
      if (handle?.cancelled) reject(new Error("cancelled"));
      else if (code === 0) resolve();
      else reject(new Error(err.trim().split(/\r?\n/).slice(-2).join(" | ") || `ffmpeg exited with ${code}`));
    });
  });
  return [...groupActivity(samples), ...groupPointer(pointer)].sort((a, b) => a.startUs - b.startUs);
}

/** Activity for a media file, from the project's cache when it has been worked out before. */
export async function activityFor(projectDir: string, mediaId: string, file: string, durationUs: number, handle: JobHandle | null, onProgress?: (p: number) => void): Promise<Activity[]> {
  // v2: pointer stretches added; older files are rebuilt.
  const cached = path.join(projectDir, "cache", "activity", `${mediaId}.v2.json`);
  if (existsSync(cached)) {
    try {
      return JSON.parse(await readFile(cached, "utf8")) as Activity[];
    } catch {
      /* rebuild */
    }
  }
  const found = await detectActivity(file, handle, durationUs, onProgress);
  await mkdir(path.dirname(cached), { recursive: true });
  await writeFile(cached, JSON.stringify(found), "utf8");
  return found;
}
