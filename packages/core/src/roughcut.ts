import { sequence, type SeqItem, type Transcripts } from "./transcript.js";
import type { Clip, Op, Project, RemovedWhy, Us } from "./types.js";

/**
 * The automatic first pass. It only suggests: every suggestion is a cut the
 * owner can accept or reject, and nothing here changes the project.
 *
 * Rules (owner's defaults): the point is to take out flubbed lines, where a
 * line is said, fumbled and said again, keeping the clean take. Filler words
 * go too. Pauses are handled gently: only ones over a second and a half are
 * trimmed, and to about 0.8 s, and every cut leaves the natural pause around it.
 */
export interface RoughCutOptions {
  /** Pauses longer than this are trimmed. */
  maxSilenceUs: Us;
  /** What a trimmed pause is left at. */
  keepSilenceUs: Us;
  fillers: string[];
  silences: boolean;
  removeFillers: boolean;
  retakes: boolean;
  /** How much of the real silence next to a cut is left on each side. */
  breathUs: Us;
  /**
   * Flubbed lines found by reading the transcript (by the agent), as index
   * ranges into sequence(project, transcripts). Each is the attempt to remove.
   */
  judged?: { from: number; to: number; reason?: string }[];
}

export const ROUGH_CUT_DEFAULTS: RoughCutOptions = {
  maxSilenceUs: 1_500_000,
  keepSilenceUs: 800_000,
  fillers: ["um", "uh", "uhm", "umm", "er", "erm", "ah", "hmm", "mm", "mhm"],
  silences: true,
  removeFillers: true,
  retakes: true,
  breathUs: 250_000,
};

export interface Suggestion {
  id: string;
  kind: "silence" | "filler" | "retake" | "zoom" | "other";
  /** One line the owner reads: what goes and why. */
  label: string;
  /** Where to jump to hear it: clip and source time. */
  clipId?: string;
  mediaId?: string;
  atUs?: Us;
  /** How much shorter the video gets. */
  savedUs: Us;
  ops: Op[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
const quote = (items: SeqItem[]) => {
  const words = items.filter((i) => i.kind === "word").map((i) => i.text);
  return words.length <= 8 ? words.join(" ") : `${words.slice(0, 4).join(" ")} … ${words.slice(-3).join(" ")}`;
};

const STUTTER = new Set("the a an to and of in is it i we you that this so but for on with if or then at as be".split(" "));

const ENDS = /[.!?]["')\]]?$/;
/** True when a word begins a sentence or follows a real pause. */
function startsLine(words: W[], k: number): boolean {
  const prev = words[k - 1];
  if (!prev || prev.item.clipId !== words[k]!.item.clipId) return true;
  return ENDS.test(prev.item.text) || words[k]!.item.startUs - prev.item.endUs >= 400_000;
}

interface W {
  i: number;
  item: SeqItem;
  key: string;
}

/**
 * Finds restarts: the speaker begins a phrase, stops, and says it again. The
 * earlier attempt is removed and the last one kept.
 *
 * A restart is a run of words that reappears shortly after it began. The
 * whole first attempt must be repeated, or at least three words and half of
 * it, so ordinary repetition ("and the tools and the skills") is left alone.
 */
function findRetakes(words: W[]): [number, number][] {
  const out: [number, number][] = [];
  let k = 0;
  while (k < words.length) {
    let found: [number, number] | null = null;
    const limit = Math.min(words.length - 1, k + 25);
    for (let j = k + 1; j <= limit && !found; j++) {
      if (words[j]!.key !== words[k]!.key || !words[k]!.key) continue;
      if (words[j]!.item.clipId !== words[k]!.item.clipId) break;
      let n = 0;
      while (j + n < words.length && k + n < j && words[k + n]!.key === words[j + n]!.key) n++;
      const gap = j - k;
      // Either the whole aborted attempt is said again, or at least three words of it are and they make up half of it.
      const need = Math.min(gap, Math.max(3, Math.ceil(gap / 2)));
      // A doubled joining word is a stutter; a doubled content word is usually emphasis ("very very").
      if (gap === 1 && !STUTTER.has(words[k]!.key)) continue;
      if (n < need) continue;
      // An attempt that ends as a finished sentence is usually not a flub: "what this is. This is ..." or two
      // sentences built alike. It only counts when the whole sentence is said again, word for word, from its start.
      if (ENDS.test(words[j - 1]!.item.text) && !(n === gap && startsLine(words, k))) continue;
      found = [k, j - 1];
    }
    if (found) {
      out.push(found);
      k = found[1] + 1;
    } else k++;
  }
  return out;
}

/** Suggestions for one project, in play order. */
export function roughCut(project: Project, transcripts: Transcripts, options: Partial<RoughCutOptions> = {}): Suggestion[] {
  const o = { ...ROUGH_CUT_DEFAULTS, ...options };
  const seq = sequence(project, transcripts);
  const fillers = new Set(o.fillers.map(norm));
  const out: Suggestion[] = [];
  const taken = new Set<number>();
  let n = 0;
  const id = (kind: string) => `s${++n}_${kind}`;

  const words: W[] = [];
  seq.forEach((item, i) => {
    if (item.kind === "word" && !item.removed) words.push({ i, item, key: norm(item.text) });
  });

  const cutWords = (first: number, last: number, why: RemovedWhy): { op: Op; savedUs: Us } | null => {
    const a = seq[first]!;
    const clip = project.items[a.clipId] as Clip;
    // From the end of the kept word before to the start of the kept word after.
    let before = first - 1;
    while (before >= 0 && seq[before]!.clipId === clip.id && (seq[before]!.kind === "pause" || seq[before]!.removed)) before--;
    let after = last + 1;
    while (after < seq.length && seq[after]!.clipId === clip.id && (seq[after]!.kind === "pause" || seq[after]!.removed)) after++;
    // The kept words on both sides keep the pause they had, up to the breathing room; the cut never reaches into them
    // and never keeps part of a removed word.
    const hasBefore = before >= 0 && seq[before]!.clipId === clip.id;
    const hasAfter = after < seq.length && seq[after]!.clipId === clip.id;
    // A long pause next to the cut is left like any trimmed pause; a short one keeps the breathing room.
    const keep = (gap: Us) => Math.min(Math.max(0, gap), gap > 500_000 ? Math.max(o.breathUs, o.keepSilenceUs / 2) : o.breathUs);
    const startUs = hasBefore ? seq[before]!.endUs + keep(a.startUs - seq[before]!.endUs) : clip.sourceInUs;
    const endUs = hasAfter ? seq[after]!.startUs - keep(seq[after]!.startUs - seq[last]!.endUs) : clip.sourceOutUs;
    if (endUs - startUs < 60_000) return null;
    const wordIds = seq.slice(first, last + 1).flatMap((x) => (x.wordId ? [x.wordId] : []));
    return { op: { op: "range.remove", clipId: clip.id, startUs, endUs, why, pad: false, wordIds }, savedUs: endUs - startUs };
  };

  if (o.retakes) {
    // Flubs found by reading come first; the word-matching finder fills in what they did not cover.
    for (const j of o.judged ?? []) {
      let first = Math.round(Math.min(j.from, j.to));
      let last = Math.round(Math.max(j.from, j.to));
      if (!(first >= 0) || !(last < seq.length)) continue;
      while (first <= last && seq[first]!.kind !== "word") first++;
      while (last >= first && seq[last]!.kind !== "word") last--;
      if (first > last || seq[first]!.clipId !== seq[last]!.clipId) continue;
      const span = seq.slice(first, last + 1);
      if (span.some((x, k) => x.removed || taken.has(first + k)) || span.filter((x) => x.kind === "word").length > 120) continue;
      const cut = cutWords(first, last, "retake");
      if (!cut) continue;
      for (let i = first; i <= last; i++) taken.add(i);
      const item = seq[first]!;
      const reason = (j.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 90);
      out.push({ id: id("retake"), kind: "retake", label: `Flubbed line: "${quote(span)}"${reason ? ` (${reason})` : ""}`, clipId: item.clipId, mediaId: item.mediaId, atUs: item.startUs, savedUs: cut.savedUs, ops: [cut.op] });
    }
    for (const [a, b] of findRetakes(words)) {
      const first = words[a]!.i;
      const last = words[b]!.i;
      // Next to a flub already marked (within a few words), it is the same repeat seen from the other side:
      // cutting both would remove the clean take too.
      let overlaps = false;
      for (let i = Math.max(0, first - 4); i <= last + 4; i++) overlaps ||= taken.has(i);
      if (overlaps) continue;
      const cut = cutWords(first, last, "retake");
      if (!cut) continue;
      for (let i = first; i <= last; i++) taken.add(i);
      const item = seq[first]!;
      out.push({ id: id("retake"), kind: "retake", label: `Repeated: "${quote(seq.slice(first, last + 1))}"`, clipId: item.clipId, mediaId: item.mediaId, atUs: item.startUs, savedUs: cut.savedUs, ops: [cut.op] });
    }
  }

  if (o.removeFillers) {
    for (const w of words) {
      if (taken.has(w.i) || !fillers.has(w.key)) continue;
      const cut = cutWords(w.i, w.i, "filler");
      if (!cut) continue;
      taken.add(w.i);
      out.push({ id: id("filler"), kind: "filler", label: w.item.lowConfidence && /\?$/.test(w.item.text) ? "Possible um or uh (heard in a pause, not written down)" : `Filler: "${w.item.text}"`, clipId: w.item.clipId, mediaId: w.item.mediaId, atUs: w.item.startUs, savedUs: cut.savedUs, ops: [cut.op] });
    }
  }

  if (o.silences) {
    // Work from the gaps between kept words, so a pause next to a removed word is not counted twice.
    for (let i = 0; i < seq.length; i++) {
      const it = seq[i]!;
      if (it.kind !== "pause" || it.removed) continue;
      if (taken.has(i - 1) || taken.has(i + 1)) continue;
      const len = it.endUs - it.startUs;
      if (len <= o.maxSilenceUs) continue;
      const clip = project.items[it.clipId] as Clip;
      // Dead air at either end of a clip: no kept word of this clip before it, or none after.
      const keptWord = (from: number, step: number) => {
        for (let k = from; k >= 0 && k < seq.length && seq[k]!.clipId === it.clipId; k += step) {
          if (seq[k]!.kind === "word" && !seq[k]!.removed) return true;
        }
        return false;
      };
      const atStart = !keptWord(i - 1, -1);
      const atEnd = !keptWord(i + 1, 1);
      if (atStart && atEnd) continue;
      // In the middle of speech keep a natural pause; dead air at the ends keeps half of that on the speech side.
      const lead = atStart ? 0 : atEnd ? o.keepSilenceUs : o.keepSilenceUs / 2;
      const tail = atEnd ? 0 : atStart ? o.keepSilenceUs : o.keepSilenceUs / 2;
      const startUs = Math.round(it.startUs + lead);
      const endUs = Math.round(it.endUs - tail);
      if (endUs - startUs < 100_000) continue;
      out.push({
        id: id("silence"),
        kind: "silence",
        label: `Silence of ${(len / 1e6).toFixed(1)} s${atStart ? " at the start" : atEnd ? " at the end" : ""}`,
        clipId: it.clipId,
        mediaId: it.mediaId,
        atUs: it.startUs,
        savedUs: endUs - startUs,
        ops: [{ op: "range.remove", clipId: it.clipId, startUs, endUs, why: "silence", pad: false }],
      });
    }
  }

  const order = new Map(seq.map((s, i) => [`${s.clipId}:${s.startUs}`, i]));
  return out.sort((a, b) => (order.get(`${a.clipId}:${a.atUs}`) ?? 0) - (order.get(`${b.clipId}:${b.atUs}`) ?? 0));
}

/** A set of suggested edits waiting for the owner's yes or no. */
export interface Proposal {
  id: string;
  by: "user" | "agent";
  summary: string;
  createdAt: string;
  /** The project revision the suggestions were made against. */
  baseRevision: number;
  items: Suggestion[];
}

/** The source ranges a proposal would remove from a clip, for drawing them ghosted. */
export function proposedRanges(proposals: Proposal[], skip: Set<string> = new Set()): Map<string, { startUs: Us; endUs: Us; kind: string; id: string }[]> {
  const map = new Map<string, { startUs: Us; endUs: Us; kind: string; id: string }[]>();
  for (const p of proposals) {
    for (const item of p.items) {
      if (skip.has(item.id)) continue;
      for (const op of item.ops) {
        if (op.op !== "range.remove") continue;
        const list = map.get(op.clipId) ?? [];
        list.push({ startUs: op.startUs, endUs: op.endUs, kind: item.kind, id: item.id });
        map.set(op.clipId, list);
      }
    }
  }
  return map;
}
