import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { applyTransaction, createProject, Session, type Clip, type HistoryRecord, type Op, type Project, type Transcript } from "@sous-chef/core";
import { answerRoughCut, lessonReport, recordRoughCut, roughCutsFromHistory, writeLessonReport } from "../src/lessons.js";

const S = 1_000_000;
let n = 0;
const opts = { newId: (p: string) => `${p}${++n}` };
const run = (p: Project, ...ops: Op[]) => applyTransaction(p, { id: `t${++n}`, baseRevision: p.revision, by: "user", summary: "t", ops }, opts).project;
const dir = mkdtempSync(path.join(os.tmpdir(), "sous-lessons-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// One word a second: "w0".."w19", each 0.8 s long.
const words = "so um today we will uh look at the new the new plugin and then we install it now".split(" ");
const transcript: Transcript = { schema: 1, engine: "t", model: "t", silences: [], words: words.map((text, i) => ({ id: `w${i}`, text, startUs: i * S, endUs: i * S + 0.8 * S })) };
const transcripts = { rec: transcript };
const base = () =>
  run(
    createProject(),
    { op: "media.add", media: { id: "rec", path: "/raw/rec.mp4", kind: "video", durationUs: 20 * S, probe: { hasVideo: true, hasAudio: true, width: 1920, height: 1080, fps: 30 } } },
    { op: "clip.add", trackId: "main", mediaId: "rec", id: "c1" },
  );
const cut = (a: number, b: number, why = "filler"): Op => ({ op: "range.remove", clipId: "c1", startUs: a * S, endUs: b * S, why, pad: false } as Op);

describe("learning from finished rough cuts", () => {
  it("reports cuts put back, suggestions said no to, and cuts added, in words", async () => {
    let p = base();
    const items = [
      { id: "s1", kind: "filler", label: "um", ops: [cut(1, 2)] },
      { id: "s2", kind: "retake", label: "repeated line", ops: [cut(8, 11, "retake")] },
      { id: "s3", kind: "filler", label: "uh", ops: [cut(5, 6)] },
    ];
    await recordRoughCut(dir, p, { id: "pr1", createdAt: "2026-11-25T00:00:00Z", summary: "Rough cut: 3 cuts", items });
    await answerRoughCut(dir, "pr1", { accepted: ["s1", "s3"] });
    p = run(p, items[0]!.ops[0]!, items[2]!.ops[0]!);
    // The owner puts the "um" back, and cuts "then we" themselves.
    const um = (p.items.c1 as Clip).removed.find((r) => r.startUs === 1 * S)!;
    p = run(p, { op: "range.restore", clipId: "c1", rangeIds: [um.id] }, cut(14, 16, "user"));
    const r = await writeLessonReport(dir, p, transcripts, []);
    expect(r.findings).toBe(3);
    const md = readFileSync(r.path, "utf8");
    expect(md).toMatch(/put them back \(1\)[\s\S]*\[um\]/);
    expect(md).toMatch(/said no \(1\)[\s\S]*\[the new the\]/);
    expect(md).toMatch(/Hermes had left in \(1\)[\s\S]*\[then we\]/);
    expect(md).toMatch(/still cut \(it got these right\): 1 filler word/);
  });

  it("leaves footage taken off the timeline out of the lessons", async () => {
    let p = base();
    const rec = { schema: 1 as const, proposalId: "x", createdAt: "2026-11-25", revision: p.revision, summary: "Rough cut", kept: { rec: [[0, 20 * S] as [number, number]] }, items: [{ id: "s1", kind: "filler", label: "um", ranges: { rec: [[1 * S, 2 * S] as [number, number]] }, verdict: "skipped" as const }] };
    p = run(p, { op: "clip.remove", clipId: "c1" });
    const r = lessonReport("t", p, transcripts, [rec]);
    expect(r.findings).toBe(0);
  });

  it("finds rough cuts accepted before this existed in the edit history", () => {
    // History from an empty project, so revisions line up with the records.
    const s0 = new Session(createProject(), opts);
    const all: HistoryRecord[] = [];
    const step = (summary: string, ops: Op[]) => all.push(s0.apply({ id: `g${++n}`, baseRevision: s0.project.revision, by: "user", summary, ops }).record!);
    step("Import", [{ op: "media.add", media: { id: "rec", path: "/raw/rec.mp4", kind: "video", durationUs: 20 * S, probe: { hasVideo: true, hasAudio: true, width: 1920, height: 1080, fps: 30 } } }]);
    step("Add", [{ op: "clip.add", trackId: "main", mediaId: "rec", id: "c1" }]);
    step("Accept: Rough cut: 2 cuts", [cut(1, 2), cut(5, 6)]);
    const um = (s0.project.items.c1 as Clip).removed.find((r) => r.startUs === 1 * S)!;
    step("Restore", [{ op: "range.restore", clipId: "c1", rangeIds: [um.id] }]);
    const recs = roughCutsFromHistory(s0.project, all);
    expect(recs).toHaveLength(1);
    const r = lessonReport("t", s0.project, transcripts, recs, true);
    expect(r.findings).toBe(1);
    expect(r.markdown).toMatch(/put them back \(1\)[\s\S]*\[um\]/);
  });
});
