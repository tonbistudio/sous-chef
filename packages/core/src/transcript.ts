import { clipDurationUs, keptRanges } from "./compile.js";
import type { Clip, Op, Project, RemovedWhy, Us } from "./types.js";

/** One word as the speech engine heard it. Never edited; fixes live in the project. */
export interface Word {
  id: string;
  text: string;
  startUs: Us;
  endUs: Us;
  conf?: number;
  guessed?: boolean;
  seg?: number;
}

export interface Transcript {
  schema: number;
  engine: string;
  model: string;
  words: Word[];
  /** Stretches with no sound, measured from the audio. */
  silences: [Us, Us][];
}

export type Transcripts = Record<string, Transcript | null | undefined>;

/** A word or a pause as it appears in the edit, in play order. */
export interface SeqItem {
  kind: "word" | "pause";
  clipId: string;
  mediaId: string;
  /** Words only. */
  wordId?: string;
  /** Shown text: the fix when there is one. */
  text: string;
  /** Source time in the clip's media. */
  startUs: Us;
  endUs: Us;
  removed: boolean;
  /** Who or what removed it, when removed. */
  why?: RemovedWhy;
  fixed?: boolean;
  lowConfidence?: boolean;
  /** Spoken on a voiceover or other audio clip, not the main track. Has its own timeline time (tlStartUs/tlEndUs). */
  voice?: boolean;
  tlStartUs?: Us;
  tlEndUs?: Us;
  /** On a muted clip: shown, but not heard, so it gets no caption. */
  silent?: boolean;
}

/** Gaps at least this long are shown as a pause the user can delete. */
export const PAUSE_US = 500_000;

export function mainClips(project: Project): Clip[] {
  const main = project.tracks.find((t) => t.kind === "main");
  return (main?.items ?? []).map((id) => project.items[id]).filter((i): i is Clip => i?.type === "clip");
}

function removedAt(clip: Clip, us: Us): RemovedWhy | null {
  for (const r of clip.removed) if (us >= r.startUs && us < r.endUs) return r.why;
  return null;
}

/**
 * The transcript of the edit: every main clip's words in play order, with
 * pauses between them, each marked removed or kept. Voiceovers and other
 * spoken audio clips are part of it too (unless `voice: false`): their words
 * and pauses go in where the clip starts on the timeline, and they are cut
 * the same way, by removing ranges from the clip.
 */
export function sequence(project: Project, transcripts: Transcripts, options: { voice?: boolean } = {}): SeqItem[] {
  const blocks: { at: Us; order: number; items: SeqItem[] }[] = [];
  let order = 0;
  const mainMuted = project.tracks.find((t) => t.kind === "main")?.muted === true;
  let cursor = 0;
  for (const clip of mainClips(project)) {
    const at = project.freeMain ? clip.startUs : cursor;
    cursor = at + clipDurationUs(clip, project.settings.cut);
    const items = clipItems(project, transcripts, clip, false, clip.muted || mainMuted);
    if (items.length) blocks.push({ at, order: order++, items });
  }
  if (options.voice !== false) {
    for (const track of project.tracks) {
      if (track.kind !== "audio" || track.muted) continue;
      for (const id of track.items) {
        const clip = project.items[id];
        if (clip?.type !== "clip" || clip.muted) continue;
        const items = clipItems(project, transcripts, clip, true, false);
        if (items.length) blocks.push({ at: clip.startUs, order: order++, items });
      }
    }
  }
  // Main clips keep their play order; spoken audio goes in by where it starts.
  blocks.sort((p, q) => p.at - q.at || p.order - q.order);
  return blocks.flatMap((b) => b.items);
}

/** Where a moment of a clip's source plays on the timeline, for a clip that sits at its own start time. */
function clipTimeline(clip: Clip, kept: [Us, Us][], srcUs: Us): Us {
  const speed = clip.speed > 0 ? clip.speed : 1;
  let t = clip.startUs;
  for (const [s, e] of kept) {
    if (srcUs < s) return t;
    if (srcUs < e) return t + Math.round((srcUs - s) / speed);
    t += Math.round((e - s) / speed);
  }
  return t;
}

/** One clip's words and pauses (pauses of at least PAUSE_US), in source order. */
function clipItems(project: Project, transcripts: Transcripts, clip: Clip, voice: boolean, muted: boolean): SeqItem[] {
  const t = transcripts[clip.mediaId];
  if (!t) return [];
  const out: SeqItem[] = [];
  const fixes = project.wordFixes[clip.mediaId] ?? {};
  const kept = voice ? keptRanges(clip, project.settings.cut) : [];
  let prevEnd = clip.sourceInUs;
  const push = (item: Omit<SeqItem, "removed" | "why">) => {
    const why = removedAt(clip, Math.floor((item.startUs + item.endUs) / 2));
    const extra: Partial<SeqItem> = muted ? { silent: true } : {};
    if (voice) {
      extra.voice = true;
      extra.tlStartUs = clipTimeline(clip, kept, item.startUs);
      extra.tlEndUs = Math.max(extra.tlStartUs, clipTimeline(clip, kept, item.endUs));
    }
    out.push(why ? { ...item, ...extra, removed: true, why } : { ...item, ...extra, removed: false });
  };
  const pause = (from: Us, to: Us) => {
    if (to - from >= PAUSE_US) push({ kind: "pause", clipId: clip.id, mediaId: clip.mediaId, text: ((to - from) / 1e6).toFixed(1) + "s", startUs: from, endUs: to });
  };
  for (const w of t.words) {
    const mid = (w.startUs + w.endUs) / 2;
    if (mid < clip.sourceInUs || mid >= clip.sourceOutUs) continue;
    pause(prevEnd, w.startUs);
    const fix = fixes[w.id];
    push({
      kind: "word",
      clipId: clip.id,
      mediaId: clip.mediaId,
      wordId: w.id,
      text: fix ?? w.text,
      startUs: Math.max(w.startUs, clip.sourceInUs),
      endUs: Math.min(w.endUs, clip.sourceOutUs),
      ...(fix ? { fixed: true } : {}),
      ...(w.guessed || (w.conf !== undefined && w.conf < 0.4) ? { lowConfidence: true } : {}),
    });
    prevEnd = Math.max(prevEnd, w.endUs);
  }
  pause(prevEnd, clip.sourceOutUs);
  return out;
}

/** Splits a run of sequence indexes into runs that stay inside one clip. */
function runsByClip(seq: SeqItem[], from: number, to: number): [number, number][] {
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(seq.length - 1, Math.max(from, to));
  const runs: [number, number][] = [];
  let start = a;
  for (let i = a + 1; i <= b + 1; i++) {
    if (i > b || seq[i]!.clipId !== seq[start]!.clipId) {
      runs.push([start, i - 1]);
      start = i;
    }
  }
  return runs;
}

/**
 * The source range to cut so items first..last of one clip disappear. It
 * reaches from the end of the word before to the start of the word after, so
 * the pause around deleted words goes with them; the project's cut padding
 * then leaves breathing room on both sides.
 */
function cutSpan(project: Project, seq: SeqItem[], first: number, last: number): [Us, Us] {
  const clip = project.items[seq[first]!.clipId] as Clip;
  const { tailPadUs, headPadUs } = project.settings.cut;
  const before = seq[first - 1]?.clipId === clip.id ? seq[first - 1] : undefined;
  const after = seq[last + 1]?.clipId === clip.id ? seq[last + 1] : undefined;
  const a = seq[first]!;
  const b = seq[last]!;
  // The cut never reaches into a kept word, and never keeps part of a removed one.
  // Breathing room comes only out of real silence next to the kept words.
  let start: Us;
  if (!before) start = clip.sourceInUs;
  else if (a.kind === "pause") start = a.startUs + Math.min(tailPadUs, Math.floor((a.endUs - a.startUs) / 2));
  else if (before.kind === "pause") start = a.startUs;
  else start = before.endUs + Math.min(tailPadUs, Math.max(0, a.startUs - before.endUs));
  let end: Us;
  if (!after) end = clip.sourceOutUs;
  else if (b.kind === "pause") end = b.endUs - Math.min(headPadUs, Math.floor((b.endUs - b.startUs) / 2));
  else if (after.kind === "pause") end = b.endUs;
  else end = after.startUs - Math.min(headPadUs, Math.max(0, after.startUs - b.endUs));
  return [start, end];
}

/** Ops that delete sequence items from..to (inclusive), across clips if needed. */
export function removeItemsOps(project: Project, seq: SeqItem[], from: number, to: number, why: RemovedWhy = "user"): Op[] {
  const ops: Op[] = [];
  for (const [a, b] of runsByClip(seq, from, to)) {
    // Skip what is already removed at the edges so a repeat delete adds nothing.
    let first = a;
    let last = b;
    while (first <= last && seq[first]!.removed) first++;
    while (last >= first && seq[last]!.removed) last--;
    if (first > last) continue;
    const [startUs, endUs] = cutSpan(project, seq, first, last);
    if (endUs <= startUs) continue;
    const wordIds = seq.slice(first, last + 1).flatMap((i) => (i.wordId ? [i.wordId] : []));
    ops.push({ op: "range.remove", clipId: seq[first]!.clipId, startUs, endUs, why, pad: false, ...(wordIds.length ? { wordIds } : {}) });
  }
  return ops;
}

/** Ops that bring sequence items from..to back, leaving the rest of each cut in place. */
export function restoreItemsOps(project: Project, seq: SeqItem[], from: number, to: number): Op[] {
  const ops: Op[] = [];
  for (const [a, b] of runsByClip(seq, from, to)) {
    const clip = project.items[seq[a]!.clipId] as Clip;
    // Restore reaches to the neighbours, mirroring how a delete was cut.
    const before = seq[a - 1];
    const after = seq[b + 1];
    const selStart = before && before.clipId === clip.id ? before.endUs : clip.sourceInUs;
    const selEnd = after && after.clipId === clip.id ? after.startUs : clip.sourceOutUs;
    const hit = clip.removed.filter((r) => r.startUs < seq[b]!.endUs && r.endUs > seq[a]!.startUs);
    if (!hit.length) continue;
    ops.push({ op: "range.restore", clipId: clip.id, rangeIds: hit.map((r) => r.id) });
    for (const r of hit) {
      const keepWords = (lo: Us, hi: Us) => r.wordIds?.filter((id) => seq.some((i) => i.clipId === clip.id && i.wordId === id && i.startUs >= lo && i.endUs <= hi));
      if (selStart - r.startUs > 20_000) {
        const wordIds = keepWords(r.startUs, selStart);
        ops.push({ op: "range.remove", clipId: clip.id, startUs: r.startUs, endUs: selStart, why: r.why, pad: r.pad, ...(wordIds?.length ? { wordIds } : {}) });
      }
      if (r.endUs - selEnd > 20_000) {
        const wordIds = keepWords(selEnd, r.endUs);
        ops.push({ op: "range.remove", clipId: clip.id, startUs: selEnd, endUs: r.endUs, why: r.why, pad: r.pad, ...(wordIds?.length ? { wordIds } : {}) });
      }
    }
  }
  return ops;
}

/** Index of the item playing at a source time of a clip, or -1. */
export function itemAt(seq: SeqItem[], clipId: string, srcUs: Us): number {
  let best = -1;
  for (let i = 0; i < seq.length; i++) {
    const it = seq[i]!;
    if (it.clipId !== clipId) continue;
    if (srcUs >= it.startUs) best = i;
    else break;
  }
  return best;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");

/** Finds a phrase in the sequence. Returns [first, last] index pairs. */
export function searchSequence(seq: SeqItem[], phrase: string, includeRemoved = true): [number, number][] {
  const want = phrase.split(/\s+/).map(norm).filter(Boolean);
  if (!want.length) return [];
  const words = seq.map((it, i) => ({ it, i })).filter((x) => x.it.kind === "word" && (includeRemoved || !x.it.removed));
  const hits: [number, number][] = [];
  for (let k = 0; k + want.length <= words.length; k++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      const have = norm(words[k + j]!.it.text);
      // The last word may be a prefix, so a search matches as you type.
      if (j === want.length - 1 ? !have.startsWith(want[j]!) : have !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push([words[k]!.i, words[k + want.length - 1]!.i]);
  }
  return hits;
}
