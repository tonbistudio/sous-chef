import type { ChildProcess } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sequence, type Project, type SeqItem, type Transcripts } from "@sous-chef/core";
import { askHermes } from "./chat.js";

/**
 * Finding flubbed lines by reading. A speaker who fumbles a line and says it
 * again often rewords it, so matching words misses most of them; the user's
 * own Hermes agent reads the transcript and points at the attempt to remove.
 * Its answer is only ever used as index ranges, checked before use.
 */
export interface Judged {
  from: number;
  to: number;
  reason?: string;
}

/** Words per part. The debug setting exists to try the parallel reading on a short take. */
const CHUNK_WORDS = Number(process.env.SOUS_CHEF_DEBUG_CHUNK_WORDS) >= 200 ? Number(process.env.SOUS_CHEF_DEBUG_CHUNK_WORDS) : 2200;
const OVERLAP_WORDS = 120;

const INSTRUCTIONS = `You are helping edit a narrated screen recording. Below is its transcript. Every word has a number in front (number:word). [1.2s] marks a pause of that length.

Find every flubbed line: the speaker starts or says something, isn't happy with it, and says it again. Mark the FIRST, worse attempt, so that removing it leaves the better take and the speech still reads naturally from the word before the range to the word after it. The person editing reviews every mark, so a likely flub you leave out costs more than one they have to reject.

Work through it sentence by sentence and compare each sentence or fragment with the next one to three. Mark it when the next one says the same thing again, even if it is reworded, shorter, longer, or the order changed. These are all flubs:
- A restated line: "The new version ships with Docker support. So the new version now supports running in Docker." (mark the first sentence)
- A self-corrected word or phrase: "open the settings files, open the settings file and..." (mark the first attempt); "click the export, uh, the exporter button. Click the export button..." (mark the first attempt)
- A stutter on a word or phrase: "Faster, faster builds" (mark the first "Faster,"); "the main window, the main window" (mark one)
- A false start that is abandoned or restarted: "we're going to install the, Let's install the plugin" (mark "we're going to install the,")
- A fragment that trails off and leads nowhere.
Include fillers and the pause that belong to the flubbed attempt, but never words of the clean take.

Do NOT mark: deliberate lists or emphasis, a summary of something said much earlier (more than about three sentences back), two different points that only sound alike, or speech that reads the screen aloud as part of the demo.

Do not use any tools. Reply with only a JSON array, no other text: [{"from": <first word number>, "to": <last word number>, "reason": "<up to 8 plain words>"}]. Reply [] if there are none.

Transcript:
`;

/** The kept words as numbered text, split into pieces a model reads in one go. */
export function numberedChunks(seq: SeqItem[]): string[] {
  const kept = seq.map((item, i) => ({ item, i })).filter((x) => !x.item.removed && !x.item.voice);
  const words = kept.filter((x) => x.item.kind === "word");
  if (words.length < 12) return [];
  const chunks: string[] = [];
  for (let start = 0; start < words.length; start += CHUNK_WORDS - OVERLAP_WORDS) {
    const lo = words[start]!.i;
    const hi = words[Math.min(words.length, start + CHUNK_WORDS) - 1]!.i;
    let clip = "";
    const parts: string[] = [];
    for (const { item, i } of kept) {
      if (i < lo || i > hi) continue;
      if (item.clipId !== clip) {
        if (clip) parts.push("\n--- next clip ---\n");
        clip = item.clipId;
      }
      // The words are the speaker's; brackets and line breaks are stripped so they cannot pass for markers.
      parts.push(item.kind === "pause" ? `[${item.text}]` : `${i}:${item.text.replace(/[\[\]\s]+/g, "")}`);
    }
    chunks.push(parts.join(" "));
    if (start + CHUNK_WORDS >= words.length) break;
  }
  return chunks;
}

/** Pulls the ranges out of an answer, dropping anything that is not a plain pair of numbers. */
export function parseJudged(answer: string): Judged[] {
  const a = answer.indexOf("[");
  const b = answer.lastIndexOf("]");
  if (a < 0 || b <= a) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(answer.slice(a, b + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: Judged[] = [];
  for (const r of raw) {
    const o = r as { from?: unknown; to?: unknown; reason?: unknown };
    if (!Number.isInteger(o?.from) || !Number.isInteger(o?.to)) continue;
    out.push({ from: Math.min(o.from as number, o.to as number), to: Math.max(o.from as number, o.to as number), ...(typeof o.reason === "string" ? { reason: o.reason.replace(/[^\p{L}\p{N} ,'-]+/gu, " ").trim().slice(0, 90) } : {}) });
  }
  return out;
}

/**
 * One question for the whole transcript: the pieces go in files, and Hermes
 * hands each to a subagent so they are read side by side, then merges the
 * answers. Asked in the project's one rough-cut session, which every rough
 * cut resumes, so a rough cut adds no new sessions to the list.
 */
function fanOutQuestion(files: string[]): string {
  return [
    `Rough cut: find the flubbed lines in this video's transcript. It is in ${files.length} part${files.length === 1 ? "" : "s"}:`,
    ...files.map((f, i) => `${i + 1}. ${f}`),
    "",
    files.length > 1
      ? `Read them in parallel: call delegate_task ONCE with ${files.length} tasks, one per part. Give each subagent the instructions below and its file path, and tell it to read the file with read_file and reply with only the JSON array. Then merge their arrays (drop exact duplicates from where parts overlap).`
      : "Read the file with read_file and apply the instructions below yourself.",
    "Earlier rough cuts in this session were of an older version of the edit: their word numbers no longer apply, so do not reuse them.",
    "",
    "Instructions:",
    INSTRUCTIONS.replace("Below is its transcript.", "The transcript is in the file.").replace("Do not use any tools. ", "Use no tools other than reading the file. ").replace(/\n*Transcript:\n*$/, ""),
    "",
    "Your final reply: only the merged JSON array, nothing else.",
  ].join("\n");
}

/** The project's rough-cut session name. */
export function roughCutSession(projectDir: string): string {
  return `Sous Chef rough cut: ${path.basename(projectDir).replace(/\.(sous|aigedit|cutroom)$/i, "")}`;
}

/**
 * Asks Hermes for the flubbed lines of the open timeline. Returns null when
 * Hermes could not be asked, so the caller can say so and carry on without.
 */
export async function judgeRetakes(
  project: Project,
  transcripts: Transcripts,
  cwd: string,
  progress: (done: number, total: number) => void = () => {},
  ask: (question: string, session?: string) => Promise<string> = (q, s) => askHermes(q, cwd, s ? 15 * 60_000 : 4 * 60_000, undefined, s ? { session: s } : {}),
): Promise<Judged[] | null> {
  const seq = sequence(project, transcripts);
  const chunks = numberedChunks(seq);
  if (!chunks.length) return [];
  const found: Judged[] = [];
  let answered = 0;
  // First choice: one question in the project's rough-cut session, read in parallel by subagents.
  const dir = path.join(cwd, "cache", "roughcut");
  try {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const files: string[] = [];
    for (const [n, chunk] of chunks.entries()) {
      const f = path.join(dir, `transcript-part-${n + 1}.txt`);
      await writeFile(f, chunk, "utf8");
      files.push(f.replace(/\\/g, "/"));
    }
    progress(0, 1);
    const answer = await ask(fanOutQuestion(files), roughCutSession(cwd));
    if (answer.includes("[")) {
      found.push(...parseJudged(answer));
      answered = 1;
    }
  } catch {
    /* fall back to asking piece by piece */
  }
  if (!answered) {
    for (const [n, chunk] of chunks.entries()) {
      progress(n, chunks.length);
      try {
        found.push(...parseJudged(await ask(INSTRUCTIONS + chunk)));
        answered++;
      } catch {
        /* this piece goes without */
      }
    }
  }
  if (!answered) return null;
  // Keep what is sane: inside the transcript, not huge, and not overlapping an earlier pick.
  const words = seq.filter((x) => x.kind === "word" && !x.removed).length;
  const out: Judged[] = [];
  let total = 0;
  for (const j of found.sort((p, q) => p.from - q.from)) {
    if (j.from < 0 || j.to >= seq.length) continue;
    const size = seq.slice(j.from, j.to + 1).filter((x) => x.kind === "word").length;
    if (!size || size > 120) continue;
    if (out.some((o) => j.from <= o.to && j.to >= o.from)) continue;
    // A reader that marks a quarter of the video has misunderstood the job.
    if (total + size > words * 0.25) break;
    total += size;
    out.push(j);
  }
  return out;
}

export type { ChildProcess };
