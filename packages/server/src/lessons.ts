import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyPatch, keptRanges, type HistoryRecord, type Op, type Project, type Transcript, type Transcripts } from "@sous-chef/core";

/**
 * Learning from how the owner finishes a rough cut.
 *
 * Each rough cut is kept as it was offered (learning/roughcuts/<id>.json), with what the owner did
 * with every suggestion. Later, the edit as it stands is compared with it, in the transcript's words:
 * cuts the owner put back, suggestions they said no to, and cuts they made that Hermes missed. Hermes
 * reads that report and writes what it learns into its skill for this owner's cuts.
 *
 * Projects from before this existed are read from their edit history: the accepted rough cut is there
 * (which suggestions were skipped is not).
 */

type Range = [number, number];
type Ranges = Record<string, Range[]>;
export type Verdict = "waiting" | "accepted" | "skipped" | "unanswered";

export interface RoughCutItem {
  id: string;
  kind: string;
  label: string;
  mediaId?: string;
  ranges: Ranges;
  verdict: Verdict;
}

export interface RoughCutRecord {
  schema: 1;
  proposalId: string;
  createdAt: string;
  revision: number;
  summary: string;
  /** What played of each recording when the rough cut was offered. */
  kept: Ranges;
  items: RoughCutItem[];
  answeredAt?: string;
}

export const LESSONS_SKILL = "sous-chef-cut-lessons";
const dirOf = (projectDir: string) => path.join(projectDir, "learning", "roughcuts");

// ---------------------------------------------------------------- ranges

function merge(list: Range[], joinUs = 0): Range[] {
  const s = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Range[] = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + joinUs) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

function minus(a: Range[], b: Range[]): Range[] {
  const out: Range[] = [];
  const bb = merge(b);
  for (const [s0, e0] of merge(a)) {
    let s = s0;
    for (const [bs, be] of bb) {
      if (be <= s || bs >= e0) continue;
      if (bs > s) out.push([s, bs]);
      s = Math.max(s, be);
      if (s >= e0) break;
    }
    if (s < e0) out.push([s, e0]);
  }
  return out;
}

function intersect(a: Range[], b: Range[]): Range[] {
  const out: Range[] = [];
  const bb = merge(b);
  for (const [s, e] of merge(a)) for (const [bs, be] of bb) if (Math.min(e, be) > Math.max(s, bs)) out.push([Math.max(s, bs), Math.min(e, be)]);
  return merge(out);
}

const total = (r: Range[]) => r.reduce((n, [a, b]) => n + (b - a), 0);
const byMedia = (fn: (m: string) => Range[], keys: Iterable<string>): Ranges => Object.fromEntries([...new Set(keys)].map((m) => [m, fn(m)]));

/** What plays of each recording on the open timeline, and what is on it at all (played or cut out). */
export function coverage(project: Project): { kept: Ranges; span: Ranges } {
  const kept: Ranges = {};
  const span: Ranges = {};
  for (const t of project.tracks) {
    for (const id of t.items) {
      const c = project.items[id];
      if (c?.type !== "clip") continue;
      (span[c.mediaId] ??= []).push([c.sourceInUs, c.sourceOutUs]);
      (kept[c.mediaId] ??= []).push(...keptRanges(c, project.settings.cut));
    }
  }
  for (const m of Object.keys(kept)) kept[m] = merge(kept[m]!);
  for (const m of Object.keys(span)) span[m] = merge(span[m]!);
  return { kept, span };
}

/** The source ranges an edit's ops take out, by recording. */
export function removedBy(project: Project, ops: Op[]): Ranges {
  const out: Ranges = {};
  for (const op of ops) {
    if (op.op !== "range.remove") continue;
    const c = project.items[op.clipId];
    if (c?.type !== "clip") continue;
    (out[c.mediaId] ??= []).push([op.startUs, op.endUs]);
  }
  for (const m of Object.keys(out)) out[m] = merge(out[m]!);
  return out;
}

// ---------------------------------------------------------------- keeping a rough cut

export async function recordRoughCut(projectDir: string, project: Project, proposal: { id: string; createdAt: string; summary: string; items: { id: string; kind: string; label: string; mediaId?: string; ops: Op[] }[] }): Promise<void> {
  const rec: RoughCutRecord = {
    schema: 1,
    proposalId: proposal.id,
    createdAt: proposal.createdAt,
    revision: project.revision,
    summary: proposal.summary,
    kept: coverage(project).kept,
    items: proposal.items.map((it) => ({ id: it.id, kind: it.kind, label: it.label, mediaId: it.mediaId, ranges: removedBy(project, it.ops), verdict: "waiting" })),
  };
  await mkdir(dirOf(projectDir), { recursive: true });
  await writeFile(path.join(dirOf(projectDir), `${proposal.id}.json`), JSON.stringify(rec, null, 1), "utf8");
}

/** What the owner did with a rough cut: accepted these (null: all), the rest skipped; or all skipped, or replaced unanswered. */
export async function answerRoughCut(projectDir: string, proposalId: string, answer: { accepted: string[] | null } | "rejected" | "replaced"): Promise<void> {
  const file = path.join(dirOf(projectDir), `${proposalId}.json`);
  if (!existsSync(file)) return;
  const rec = JSON.parse(await readFile(file, "utf8")) as RoughCutRecord;
  if (rec.answeredAt) return;
  for (const it of rec.items) {
    if (answer === "rejected") it.verdict = "skipped";
    else if (answer === "replaced") it.verdict = "unanswered";
    else it.verdict = !answer.accepted || answer.accepted.includes(it.id) ? "accepted" : "skipped";
  }
  rec.answeredAt = new Date().toISOString();
  await writeFile(file, JSON.stringify(rec, null, 1), "utf8");
}

async function readRecords(projectDir: string): Promise<RoughCutRecord[]> {
  const names = await readdir(dirOf(projectDir)).catch(() => [] as string[]);
  const out: RoughCutRecord[] = [];
  for (const n of names.filter((x) => x.endsWith(".json"))) {
    try {
      const r = JSON.parse(await readFile(path.join(dirOf(projectDir), n), "utf8")) as RoughCutRecord;
      if (r.answeredAt && r.items.some((i) => i.verdict === "accepted" || i.verdict === "skipped")) out.push(r);
    } catch {
      /* a broken file is skipped */
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Rough cuts accepted before they were kept like this, found in the edit history. The edit as it stood
 * just before is rebuilt by stepping back from the project as it is now.
 */
export function roughCutsFromHistory(now: Project, records: HistoryRecord[]): RoughCutRecord[] {
  const out: RoughCutRecord[] = [];
  const byTx = new Map<string, Extract<HistoryRecord, { type: "apply" }>>();
  for (const r of records) if (r.type === "apply") byTx.set(r.tx.id, r);
  const hits = records.flatMap((r, i) => (r.type === "apply" && /^Accept: Rough cut/.test(r.tx.summary ?? "") && r.tx.ops.some((o) => o.op === "range.remove") ? [i] : []));
  if (!hits.length || now.revision !== records.length) return out;
  let p = now;
  let at = records.length;
  for (const k of hits.reverse()) {
    // Step back to the revision before record k.
    while (at > k) {
      at--;
      const r = records[at]!;
      const src = r.type === "apply" ? r : byTx.get(r.txId);
      if (!src) return out;
      p = applyPatch(p, r.type === "redo" || r.type === "apply" ? src.inverse : src.forward);
    }
    const tx = (records[k] as Extract<HistoryRecord, { type: "apply" }>).tx;
    const items: RoughCutItem[] = tx.ops.flatMap((op, i) => {
      if (op.op !== "range.remove") return [];
      const c = p.items[op.clipId];
      const why = (op as { why?: string }).why ?? "cut";
      return c?.type === "clip" ? [{ id: `h${i}`, kind: why === "silence" ? "silence" : why === "filler" ? "filler" : why === "retake" ? "retake" : "other", label: why, mediaId: c.mediaId, ranges: { [c.mediaId]: [[op.startUs, op.endUs] as Range] }, verdict: "accepted" as Verdict }] : [];
    });
    out.unshift({ schema: 1, proposalId: tx.id, createdAt: (records[k] as { at: string }).at, revision: k, summary: tx.summary.replace(/^Accept: /, ""), kept: coverage(p).kept, items, answeredAt: (records[k] as { at: string }).at });
  }
  return out;
}

// ---------------------------------------------------------------- the report

function wordsIn(t: Transcript | null | undefined, [s, e]: Range): string {
  if (!t) return "";
  return t.words.filter((w) => (w.startUs + w.endUs) / 2 >= s && (w.startUs + w.endUs) / 2 < e).map((w) => w.text).join(" ");
}

/** The words, with a few either side for context: …before [these] after… */
function quote(t: Transcript | null | undefined, r: Range): string {
  if (!t) return `(${((r[1] - r[0]) / 1e6).toFixed(1)} s)`;
  const mid = (w: { startUs: number; endUs: number }) => (w.startUs + w.endUs) / 2;
  const inside = wordsIn(t, r);
  const before = t.words.filter((w) => mid(w) < r[0]).slice(-6).map((w) => w.text).join(" ");
  const after = t.words.filter((w) => mid(w) >= r[1]).slice(0, 6).map((w) => w.text).join(" ");
  const body = inside ? `[${inside}]` : `[pause ${((r[1] - r[0]) / 1e6).toFixed(1)} s]`;
  return `"…${before} ${body} ${after}…"`.replace(/\s+/g, " ");
}

const clockOf = (us: number) => `${Math.floor(us / 60e6)}:${String(Math.floor((us % 60e6) / 1e6)).padStart(2, "0")}`;
const KIND: Record<string, string> = { silence: "silence", filler: "filler word", retake: "flubbed line", other: "cut" };
/** "filler word" or "flubbed line (said it twice)": the label only when it says more than the kind. */
const what = (it: RoughCutItem) => `${KIND[it.kind] ?? it.kind}${it.label && it.label !== it.kind && !["cut", "user"].includes(it.label) ? ` (${it.label})` : ""}`;

export interface LessonReport {
  roughCuts: number;
  /** Things that show what the owner wants differently: put back, said no to, cut extra. */
  findings: number;
  markdown: string;
}

/** How the owner's edit differs from Hermes's rough cuts, in words. */
export function lessonReport(name: string, now: Project, transcripts: Transcripts, recs: RoughCutRecord[], fromHistory = false): LessonReport {
  const cov = coverage(now);
  const lines: string[] = [`# ${name}: how the rough cut was finished`, ""];
  let findings = 0;
  const media = (id: string) => now.media.find((m) => m.id === id);
  const label = (m: string) => path.basename(media(m)?.path ?? m);
  for (const rec of recs) {
    const accepted = rec.items.filter((i) => i.verdict === "accepted" && Object.keys(i.ranges).length);
    const skipped = rec.items.filter((i) => i.verdict === "skipped" && Object.keys(i.ranges).length);
    const acceptedCut: Ranges = {};
    for (const it of accepted) for (const [m, r] of Object.entries(it.ranges)) (acceptedCut[m] ??= []).push(...r);
    lines.push(`## ${rec.summary.replace(/^Rough cut: /, "Rough cut, ")} (${rec.createdAt.slice(0, 10)})`, "");
    if (fromHistory) lines.push("(Read from the edit history: only the accepted cuts are known, not the ones skipped.)", "");
    // Hermes's cuts the owner still has, put back, or lost along with the footage.
    const kept: Record<string, number> = {};
    const restored: string[] = [];
    for (const it of accepted) {
      let len = 0, back = 0, there = 0;
      for (const [m, rs] of Object.entries(it.ranges)) {
        len += total(rs);
        there += total(intersect(rs, cov.span[m] ?? []));
        back += total(intersect(rs, cov.kept[m] ?? []));
      }
      if (!len || there < len * 0.5) continue; // that footage is no longer in the edit: a content change, not a verdict
      if (back > there * 0.5) {
        const m = Object.keys(it.ranges)[0]!;
        restored.push(`- ${what(it)} in ${label(m)} at ${clockOf(it.ranges[m]![0]![0])}: ${quote(transcripts[m], it.ranges[m]![0]!)}`);
      } else kept[it.kind] = (kept[it.kind] ?? 0) + 1;
    }
    const keptLine = Object.entries(kept).map(([k, n]) => `${n} ${KIND[k] ?? k}${n === 1 ? "" : "s"}`).join(", ");
    lines.push(`Cuts Hermes made that are still cut (it got these right): ${keptLine || "none"}.`, "");
    if (restored.length) lines.push(`### Hermes cut these and the owner put them back (${restored.length})`, ...restored, "");
    findings += restored.length;
    const no = skipped.flatMap((it) => {
      const m = Object.keys(it.ranges)[0]!;
      const r = it.ranges[m]![0]!;
      if (total(intersect(it.ranges[m]!, cov.span[m] ?? [])) < total(it.ranges[m]!) * 0.5) return [];
      // Skipped, but cut by hand later anyway: Hermes was right after all.
      if (total(intersect(it.ranges[m]!, cov.kept[m] ?? [])) < total(it.ranges[m]!) * 0.5) return [];
      return [`- ${what(it)} in ${label(m)} at ${clockOf(r[0])}: ${quote(transcripts[m], r)}`];
    });
    if (no.length) lines.push(`### Hermes suggested these and the owner said no (${no.length})`, ...no, "");
    findings += no.length;
    // Cuts the owner made that Hermes did not suggest, in footage that is still in the edit.
    const extra: string[] = [];
    const big: string[] = [];
    const gone: string[] = [];
    for (const [m, before] of Object.entries(rec.kept)) {
      const after = minus(before, acceptedCut[m] ?? []);
      const lost = minus(after, cov.kept[m] ?? []);
      const cutHere = merge(intersect(lost, cov.span[m] ?? []), 300_000).filter(([a, b]) => b - a >= 150_000);
      for (const r of cutHere) {
        const line = `- in ${label(m)} at ${clockOf(r[0])}: ${quote(transcripts[m], r)}`;
        if (r[1] - r[0] > 45e6) big.push(`- ${((r[1] - r[0]) / 1e6).toFixed(0)} s in ${label(m)} from ${clockOf(r[0])}, starting "${wordsIn(transcripts[m], [r[0], r[0] + 6e6])}…" and ending "…${wordsIn(transcripts[m], [r[1] - 6e6, r[1]])}"`);
        else extra.push(line);
      }
      const away = merge(minus(lost, cov.span[m] ?? []), 1e6).filter(([a, b]) => b - a >= 1e6);
      if (away.length) gone.push(`- ${label(m)}: ${away.length} stretch${away.length === 1 ? "" : "es"}, ${(total(away) / 1e6).toFixed(0)} s in all (taken off the timeline or trimmed off a clip's ends)`);
    }
    if (extra.length) lines.push(`### The owner cut these, which Hermes had left in (${extra.length})`, ...extra.slice(0, 120), ...(extra.length > 120 ? [`- …and ${extra.length - 120} more`] : []), "");
    findings += extra.length;
    if (big.length) lines.push("### Long stretches the owner cut (often a change of content, not a missed cut: judge from the words)", ...big, "");
    if (gone.length) lines.push("### Footage no longer in the edit (usually content changes: leave out of the lessons unless the words say otherwise)", ...gone, "");
  }
  return { roughCuts: recs.length, findings, markdown: lines.join("\n") };
}

/** A project's saved edit history (a torn last line is ignored). */
export async function readHistoryFile(projectDir: string): Promise<HistoryRecord[]> {
  const text = await readFile(path.join(projectDir, "history.jsonl"), "utf8").catch(() => "");
  const out: HistoryRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as HistoryRecord);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Builds the report for one project and writes it to learning/report.md. */
export async function writeLessonReport(projectDir: string, project: Project, transcripts: Transcripts, history: HistoryRecord[]): Promise<LessonReport & { path: string }> {
  let recs = await readRecords(projectDir);
  let fromHistory = false;
  if (!recs.length) {
    recs = roughCutsFromHistory(project, history);
    fromHistory = recs.length > 0;
  }
  const name = path.basename(projectDir).replace(/\.(sous|aigedit|cutroom)$/i, "");
  const report = lessonReport(name, project, transcripts, recs, fromHistory);
  const file = path.join(projectDir, "learning", "report.md");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, report.markdown, "utf8");
  return { ...report, path: file.replace(/\\/g, "/") };
}

/** What Hermes is asked to do with the reports. */
export function teachPrompt(reports: { name: string; path: string; findings: number }[]): string {
  return [
    `Learn how I like my rough cuts finished. ${reports.length === 1 ? "This report compares" : "These reports compare"} the rough cuts you suggested with how I finished the edit:`,
    ...reports.map((r) => `- ${r.name}: ${r.path} (${r.findings} things I changed)`),
    "",
    "1. Read each report with read_file. Quoted words are from the transcript; [brackets] mark what was cut or put back.",
    `2. Load your skill "${LESSONS_SKILL}" with skill_view if it exists, so you add to what you already learned instead of starting over.`,
    `3. Work out the patterns: what kinds of cuts I undo, what I say no to, and what I cut that you left in. Only patterns that show up more than once, or that are very clear, become lessons. Long stretches and footage taken off the timeline are usually content changes, not lessons: leave them out unless the words make it plain.`,
    `4. Create or update the skill "${LESSONS_SKILL}" with skill_manage. Description: "Use when making or reviewing a Sous Chef rough cut. How this owner wants cuts." Body: short imperative rules, each with one or two real quoted examples, plus how many times you saw it. Keep lessons that still hold, change ones the new reports contradict, and keep it under about 60 lines.`,
    "5. Tell me in a few bullets what you learned and what changed in the skill.",
  ].join("\n");
}
