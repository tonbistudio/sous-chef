import { compile, type Plan, type Segment } from "./compile.js";
import { roughCut, ROUGH_CUT_DEFAULTS, type Suggestion } from "./roughcut.js";
import { sequence, type SeqItem, type Transcripts } from "./transcript.js";
import type { Project, Us } from "./types.js";

/**
 * How the edit moves: the pauses still in it, and how much is said in each
 * stretch of the finished video. Read-only, like the rough cut: tightening
 * comes back as suggestions the owner applies or reviews.
 */
export interface PacingOptions {
  /** Pauses at least this long (as heard in the edit) are counted as long. */
  longUs: Us;
  /** What tightening leaves of each long pause. */
  keepUs: Us;
  /** Length of each stretch the speaking rate is measured over, in edit time. */
  windowUs: Us;
}

export const PACING_DEFAULTS: PacingOptions = { longUs: 1_000_000, keepUs: 500_000, windowUs: 30_000_000 };

export interface PacePause {
  /** Index into sequence(project, transcripts). */
  index: number;
  clipId: string;
  startUs: Us;
  endUs: Us;
  /** How long it is heard in the edit (after cut padding and speed). */
  heardUs: Us;
  /** Where it starts on the timeline. */
  tlUs: Us;
}

export interface PaceWindow {
  tlStartUs: Us;
  tlEndUs: Us;
  words: number;
  /** Words per minute of edit time. */
  wpm: number;
  /** Pause time heard in this stretch. */
  pauseUs: Us;
  /** Noticeably slower than the video's usual rate. */
  slow: boolean;
}

export interface Pacing {
  pauses: PacePause[];
  /** Total heard time of the long pauses. */
  longUs: Us;
  /** Every heard pause of half a second or more, long or not. */
  allPauseUs: Us;
  windows: PaceWindow[];
  /** The middle speaking rate of stretches with speech. */
  medianWpm: number;
  /** Cuts that bring every long pause down to keepUs. */
  tighten: Suggestion[];
  tightenSavesUs: Us;
}

/** Main-track segments of one clip, in source order. */
function segmentsByClip(plan: Plan): Map<string, Segment[]> {
  const map = new Map<string, Segment[]>();
  for (const s of plan.segments) {
    if (s.trackKind !== "main") continue;
    const list = map.get(s.clipId) ?? [];
    list.push(s);
    map.set(s.clipId, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.srcInUs - b.srcInUs);
  return map;
}

/** The parts of a source range that play, as timeline ranges. */
function heard(segs: Segment[] | undefined, startUs: Us, endUs: Us): [Us, Us][] {
  const out: [Us, Us][] = [];
  for (const s of segs ?? []) {
    const a = Math.max(startUs, s.srcInUs);
    const b = Math.min(endUs, s.srcOutUs);
    if (b <= a) continue;
    out.push([s.tlStartUs + Math.round((a - s.srcInUs) / s.speed), s.tlStartUs + Math.round((b - s.srcInUs) / s.speed)]);
  }
  return out;
}

export function pacing(project: Project, transcripts: Transcripts, options: Partial<PacingOptions> = {}, given?: { plan?: Plan; seq?: SeqItem[] }): Pacing {
  const o = { ...PACING_DEFAULTS, ...options };
  const plan = given?.plan ?? compile(project);
  const seq = given?.seq ?? sequence(project, transcripts);
  const segs = segmentsByClip(plan);
  const pauses: PacePause[] = [];
  const wordTimes: Us[] = [];
  const pauseSpans: [Us, Us][] = [];
  let allPauseUs = 0;

  seq.forEach((it, index) => {
    if (it.removed || it.voice || it.silent) return;
    const parts = heard(segs.get(it.clipId), it.startUs, it.endUs);
    if (!parts.length) return;
    if (it.kind === "word") {
      wordTimes.push(parts[0]![0]);
      return;
    }
    const heardUs = parts.reduce((t, [a, b]) => t + (b - a), 0);
    allPauseUs += heardUs;
    pauseSpans.push(...parts);
    // Over the threshold by more than rounding, the same rule tightening uses, so what it lists it also fixes.
    if (heardUs > o.longUs + 20_000) pauses.push({ index, clipId: it.clipId, startUs: it.startUs, endUs: it.endUs, heardUs, tlUs: parts[0]![0] });
  });

  const total = plan.durationUs;
  const windows: PaceWindow[] = [];
  for (let t = 0; t < total; t += o.windowUs) {
    const end = Math.min(total, t + o.windowUs);
    const words = wordTimes.filter((w) => w >= t && w < end).length;
    const pauseUs = pauseSpans.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, end) - Math.max(a, t)), 0);
    windows.push({ tlStartUs: t, tlEndUs: end, words, wpm: Math.round((words / ((end - t) / 60e6)) * 10) / 10, pauseUs, slow: false });
  }
  // The usual rate: the middle of the stretches that have speech and are long enough to judge.
  const rates = windows.filter((w) => w.words > 0 && w.tlEndUs - w.tlStartUs >= o.windowUs / 3).map((w) => w.wpm).sort((a, b) => a - b);
  const medianWpm = rates.length ? rates[Math.floor(rates.length / 2)]! : 0;
  for (const w of windows) w.slow = medianWpm > 0 && w.tlEndUs - w.tlStartUs >= o.windowUs / 3 && w.wpm < medianWpm * 0.65;

  // Tightening is the rough cut's pause rule with this threshold: it keeps the same breathing room
  // next to speech and the same handling of dead air at the ends of a take.
  // The rough cut works in source time; the thresholds here are as heard, so they scale with the main track's speed.
  const speed = project.settings.mainSpeed ?? 1;
  const tighten = roughCut(project, transcripts, { ...ROUGH_CUT_DEFAULTS, retakes: false, removeFillers: false, silences: true, maxSilenceUs: o.longUs * speed, keepSilenceUs: o.keepUs * speed, judged: [] })
    .filter((s) => s.kind === "silence");
  return {
    pauses: pauses.sort((a, b) => a.tlUs - b.tlUs),
    longUs: pauses.reduce((t, p) => t + p.heardUs, 0),
    allPauseUs,
    windows,
    medianWpm,
    tighten,
    // What it saves in the finished video: the cut source time as it plays (after speed and existing cuts).
    tightenSavesUs: tighten.reduce((t, s) => t + s.ops.reduce((u, op) => (op.op === "range.remove" ? u + heard(segs.get(op.clipId), op.startUs, op.endUs).reduce((v, [a, b]) => v + b - a, 0) : u), 0), 0),
  };
}
