import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyTransaction,
  compile,
  roughCut,
  sourceToTimeline,
  type Op,
  type Project,
  type Proposal,
  type RoughCutOptions,
  type Suggestion,
  type Transcripts,
} from "@sous-chef/core";
import type { Activity } from "./activity.js";

const dirOf = (projectDir: string) => path.join(projectDir, "proposals");
const SAFE_ID = /^[a-f0-9]{6,32}$/;

export async function listProposals(projectDir: string): Promise<Proposal[]> {
  const names = await readdir(dirOf(projectDir)).catch(() => [] as string[]);
  const out: Proposal[] = [];
  for (const n of names.filter((x) => x.endsWith(".json")).sort()) {
    try {
      out.push(JSON.parse(await readFile(path.join(dirOf(projectDir), n), "utf8")) as Proposal);
    } catch {
      /* a half-written file is not a proposal */
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function saveProposal(projectDir: string, p: Omit<Proposal, "id" | "createdAt">): Promise<Proposal> {
  const proposal: Proposal = { ...p, id: randomBytes(6).toString("hex"), createdAt: new Date().toISOString() };
  await mkdir(dirOf(projectDir), { recursive: true });
  await writeFile(path.join(dirOf(projectDir), `${proposal.id}.json`), JSON.stringify(proposal, null, 1), "utf8");
  return proposal;
}

export async function getProposal(projectDir: string, id: string): Promise<Proposal | null> {
  if (!SAFE_ID.test(id)) return null;
  try {
    return JSON.parse(await readFile(path.join(dirOf(projectDir), `${id}.json`), "utf8")) as Proposal;
  } catch {
    return null;
  }
}

export async function dropProposal(projectDir: string, id: string): Promise<void> {
  if (SAFE_ID.test(id)) await rm(path.join(dirOf(projectDir), `${id}.json`), { force: true });
}

/**
 * The ops of the chosen items that still make sense. The project may have
 * moved on since the proposal was made, so anything aimed at a clip or take
 * that no longer exists is left out and counted.
 */
export function usableOps(project: Project, proposal: Proposal, itemIds?: string[] | null): { ops: Op[]; used: number; skipped: number } {
  const want = itemIds ? new Set(itemIds) : null;
  const ops: Op[] = [];
  let used = 0;
  let skipped = 0;
  for (const item of proposal.items) {
    if (want && !want.has(item.id)) continue;
    const ok = item.ops.every((op) => {
      if (op.op === "range.remove") {
        const clip = project.items[op.clipId];
        return clip?.type === "clip" && op.endUs > clip.sourceInUs && op.startUs < clip.sourceOutUs;
      }
      if (op.op === "zoom.add") return project.media.some((m) => m.id === op.mediaId);
      return true;
    });
    if (ok) {
      ops.push(...item.ops);
      used++;
    } else skipped++;
  }
  return { ops, used, skipped };
}

/** Turns bursts of on-screen activity into zoom suggestions that fit the edit as it will be after the cuts. */
export function zoomSuggestions(project: Project, cuts: Suggestion[], activity: Record<string, Activity[]>, startIndex = 0): Suggestion[] {
  // Look at the edit with the suggested cuts applied, so no zoom lands on something being removed.
  let after = project;
  try {
    const ops = cuts.flatMap((c) => c.ops);
    if (ops.length) after = applyTransaction(project, { id: "preview", baseRevision: project.revision, by: "agent", summary: "", ops }, { newId: (p) => `${p}${randomBytes(4).toString("hex")}` }).project;
  } catch {
    after = project;
  }
  const plan = compile(after);
  const existing = Object.values(project.items).filter((i) => i.type === "zoom");
  const z = project.settings.zoom;
  const picked: { tlStart: number; tlEnd: number; s: Suggestion }[] = [];
  let n = startIndex;
  const candidates = Object.entries(activity)
    .flatMap(([mediaId, list]) => list.map((a) => ({ mediaId, a })))
    .sort((p, q) => q.a.score - p.a.score);
  // About one zoom every 45 seconds of the edit at most, the strongest first: more and the picture never settles.
  const budget = Math.max(1, Math.round(plan.durationUs / 45_000_000)) - existing.length;
  for (const { mediaId, a } of candidates) {
    if (picked.length >= budget) break;
    if (a.score < 0.45) continue;
    // Hold long enough to read, not so long that it overstays.
    // A short burst still gets a steady stretch between zooming in and out (in + 2 s + out).
    if (a.endUs - a.startUs < 2_000_000) continue;
    const startUs = a.startUs;
    const media = project.media.find((m) => m.id === mediaId);
    const endUs = Math.min(media?.durationUs ?? a.endUs, Math.max(a.endUs, a.startUs + z.inUs + z.outUs + 2_000_000), a.startUs + 12_000_000);
    const tlStart = sourceToTimeline(plan, mediaId, startUs);
    const tlEnd = sourceToTimeline(plan, mediaId, endUs - 1000);
    if (tlStart === null || tlEnd === null || tlEnd - tlStart < 1_500_000) continue;
    if (tlStart < z.inUs) continue;
    if (existing.some((e) => e.type === "zoom" && e.mediaId === mediaId && e.startUs < endUs && e.endUs > startUs)) continue;
    // Leave room between zooms so the picture is not always moving.
    const gap = z.inUs + z.outUs + 8_000_000;
    if (picked.some((p) => tlStart < p.tlEnd + gap && tlEnd > p.tlStart - gap)) continue;
    // Never zoom tighter than a quarter of the screen: a wider box keeps context readable.
    const [x, y, w, h] = a.rect;
    const bw = Math.max(w, 0.3);
    const bh = Math.max(h, 0.3);
    const rect: [number, number, number, number] = [
      Math.round(Math.max(0, Math.min(1 - bw, x + w / 2 - bw / 2)) * 1000) / 1000,
      Math.round(Math.max(0, Math.min(1 - bh, y + h / 2 - bh / 2)) * 1000) / 1000,
      Math.round(bw * 1000) / 1000,
      Math.round(bh * 1000) / 1000,
    ];
    picked.push({
      tlStart,
      tlEnd,
      s: {
        id: `s${++n}_zoom`,
        kind: "zoom",
        label: `Zoom for ${((endUs - startUs) / 1e6).toFixed(0)} s ${a.kind === "pointer" ? "where you are pointing" : "where the screen is changing"}`,
        mediaId,
        atUs: startUs,
        savedUs: 0,
        ops: [{ op: "zoom.add", mediaId, startUs, endUs, rect }],
      },
    });
  }
  return picked.sort((p, q) => p.tlStart - q.tlStart).map((p) => p.s);
}

export function summarize(items: Suggestion[]): string {
  const count = (k: string) => items.filter((i) => i.kind === k).length;
  const saved = items.reduce((s, i) => s + i.savedUs, 0);
  const parts = [
    [count("silence"), "silence"],
    [count("filler"), "filler word"],
    [count("retake"), "flubbed line"],
    [count("zoom"), "zoom"],
    [count("other"), "other edit"],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, name]) => `${n} ${name}${n === 1 ? "" : "s"}`);
  const time = saved > 0 ? `, ${Math.floor(saved / 6e7)}:${String(Math.round((saved % 6e7) / 1e6)).padStart(2, "0")} shorter` : "";
  return parts.length ? `${parts.join(", ")}${time}` : "Nothing to suggest";
}

export function cutSuggestions(project: Project, transcripts: Transcripts, options?: Partial<RoughCutOptions>): Suggestion[] {
  return roughCut(project, transcripts, options);
}
