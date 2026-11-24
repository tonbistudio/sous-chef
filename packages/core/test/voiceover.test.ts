import { describe, expect, it } from "vitest";
import { applyTransaction, createProject, pacing, roughCut, sequence, Session, type Clip, type Op, type Project, type Transaction, type Transcript } from "../src/index.js";

const S = 1_000_000;
let n = 0;
const opts = { newId: (prefix: string) => `${prefix}${++n}` };
const tx = (p: Project, ops: Op[]): Transaction => ({ id: `tx${++n}`, baseRevision: p.revision, by: "user", summary: "t", ops });
const run = (p: Project, ...ops: Op[]) => applyTransaction(p, tx(p, ops), opts).project;
const clip = (p: Project, id: string) => p.items[id] as Clip;
const laneOf = (p: Project, id: string) => p.tracks.find((t) => t.items.includes(id))!.id;

/** A 30 s screen recording, a 10 s one to insert, and two 6 s voiceovers on one audio lane. */
function project(): Project {
  return run(
    createProject(),
    { op: "media.add", media: { id: "rec", path: "/raw/rec.mp4", kind: "video", durationUs: 30 * S, probe: { hasVideo: true, hasAudio: true, width: 1920, height: 1080, fps: 60 } } },
    { op: "media.add", media: { id: "intro", path: "/raw/intro.mp4", kind: "video", durationUs: 10 * S, probe: { hasVideo: true, hasAudio: true, width: 1920, height: 1080, fps: 60 } } },
    { op: "media.add", media: { id: "vo1", path: "/vo/1.m4a", kind: "audio", durationUs: 6 * S, probe: { hasVideo: false, hasAudio: true } } },
    { op: "media.add", media: { id: "vo2", path: "/vo/2.m4a", kind: "audio", durationUs: 6 * S, probe: { hasVideo: false, hasAudio: true } } },
    { op: "clip.add", trackId: "main", mediaId: "rec", id: "c1" },
    { op: "track.add", kind: "audio", id: "a1" },
    { op: "clip.add", trackId: "a1", mediaId: "vo1", id: "v1", startUs: 5 * S },
    { op: "clip.add", trackId: "a1", mediaId: "vo2", id: "v2", startUs: 15 * S },
  );
}

describe("voiceovers", () => {
  it("moves a voiceover to another audio lane, and the emptied lane goes", () => {
    let p = run(project(), { op: "track.add", kind: "audio", id: "a2" }, { op: "clip.move", clipId: "v2", trackId: "a2" });
    expect(laneOf(p, "v2")).toBe("a2");
    p = run(p, { op: "clip.move", clipId: "v2", trackId: "a1", startUs: 15 * S });
    expect(laneOf(p, "v2")).toBe("a1");
    expect(p.tracks.map((t) => t.id)).toEqual(["main", "a1"]);
  });

  it("splits a voiceover like a video clip", () => {
    const p = run(project(), { op: "clip.split", clipId: "v1", atSourceUs: 2 * S, newId: "v1b" });
    expect(clip(p, "v1").sourceOutUs).toBe(2 * S);
    expect(clip(p, "v1b")).toMatchObject({ sourceInUs: 2 * S, startUs: 7 * S });
    expect(laneOf(p, "v1b")).toBe("a1");
  });

  it("stays where it is when not locked: footage added in front leaves it behind", () => {
    const p = run(project(), { op: "clip.add", trackId: "main", mediaId: "intro", index: 0 });
    expect(clip(p, "v1").startUs).toBe(5 * S);
  });

  it("locked, it follows the recording when footage is added in front, cut before it, or moved", () => {
    let p = run(project(), { op: "clip.set", clipId: "v1", linked: true });
    expect(clip(p, "v1").link).toEqual({ mediaId: "rec", srcUs: 5 * S });
    p = run(p, { op: "clip.add", trackId: "main", mediaId: "intro", index: 0 });
    expect(clip(p, "v1").startUs).toBe(15 * S);
    // Unlocked v2 stays put.
    expect(clip(p, "v2").startUs).toBe(15 * S);
    // v1 now lands on v2 in their lane, so it moved to a lane of its own instead of overlapping.
    expect(laneOf(p, "v1")).not.toBe(laneOf(p, "v2"));
    // Cutting 2 s of the recording before it pulls it back by 2 s.
    p = run(p, { op: "range.remove", clipId: "c1", startUs: 1 * S, endUs: 3 * S, pad: false });
    expect(clip(p, "v1").startUs).toBe(13 * S);
  });

  it("dragging a locked voiceover locks it to the new moment; unlocking lets it go", () => {
    let p = run(project(), { op: "clip.set", clipId: "v1", linked: true });
    p = run(p, { op: "clip.move", clipId: "v1", startUs: 8 * S });
    expect(clip(p, "v1").link).toEqual({ mediaId: "rec", srcUs: 8 * S });
    p = run(p, { op: "clip.set", clipId: "v1", linked: false });
    p = run(p, { op: "clip.add", trackId: "main", mediaId: "intro", index: 0 });
    expect(clip(p, "v1").startUs).toBe(8 * S);
  });

  it("both halves of a split locked voiceover stay locked to their own moment", () => {
    let p = run(project(), { op: "clip.set", clipId: "v1", linked: true });
    p = run(p, { op: "clip.split", clipId: "v1", atSourceUs: 2 * S, newId: "v1b" });
    expect(clip(p, "v1b").link).toEqual({ mediaId: "rec", srcUs: 7 * S });
    p = run(p, { op: "clip.add", trackId: "main", mediaId: "intro", index: 0 });
    expect([clip(p, "v1").startUs, clip(p, "v1b").startUs]).toEqual([15 * S, 17 * S]);
  });

  it("undo puts a locked voiceover back with the footage", () => {
    let p = run(project(), { op: "clip.set", clipId: "v1", linked: true });
    const s = new Session(p, opts);
    s.apply(tx(p, [{ op: "clip.add", trackId: "main", mediaId: "intro", index: 0 }]));
    expect(clip(s.project, "v1").startUs).toBe(15 * S);
    s.undo();
    expect(clip(s.project, "v1").startUs).toBe(5 * S);
  });

  it("refuses to lock a clip with no recording under it, or a main-track clip", () => {
    const p = run(project(), { op: "clip.move", clipId: "v2", startUs: 40 * S });
    expect(() => run(p, { op: "clip.set", clipId: "v2", linked: true })).toThrow(/no screen recording/);
    expect(() => run(p, { op: "clip.set", clipId: "c1", linked: true })).toThrow(/main track/);
  });

  it("the transcript shows a voiceover's pauses and cuts, and the rough cut finds its ums and repeats", () => {
    const words = (list: [string, number, number][]): Transcript => ({ schema: 1, engine: "t", model: "t", silences: [], words: list.map(([text, a, b], i) => ({ id: `w${i}`, text, startUs: a * S, endUs: b * S })) });
    // A voiceover-only video: the recording's own sound has no words.
    const tr = {
      rec: words([]),
      vo1: words([["So", 0.1, 0.3], ["um", 0.4, 0.6], ["this", 0.7, 0.9], ["is", 1.0, 1.1], ["the", 1.2, 1.3], ["this", 1.5, 1.7], ["is", 1.8, 1.9], ["the", 2.0, 2.1], ["editor.", 2.2, 2.6], ["Next", 5.0, 5.4], ["part.", 5.5, 5.9]]),
    };
    const p = project();
    const seq = sequence(p, tr);
    const pause = seq.find((i) => i.kind === "pause" && i.clipId === "v1");
    expect(pause).toMatchObject({ voice: true, startUs: 2.6 * S, endUs: 5 * S, tlStartUs: 7.6 * S });
    const found = roughCut(p, tr);
    expect(found.map((s) => s.kind).sort()).toEqual(["filler", "retake", "silence"]);
    expect(found.every((s) => s.ops.every((o) => o.op === "range.remove" && o.clipId === "v1"))).toBe(true);
    // Taking the um out shows it removed, and the words after it play earlier.
    const um = found.find((s) => s.kind === "filler")!;
    const cut = run(p, ...um.ops);
    const after = sequence(cut, tr);
    expect(after.find((i) => i.text === "um")!.removed).toBe(true);
    expect(after.find((i) => i.text === "editor.")!.tlStartUs).toBeLessThan(5 * S + 2.2 * S);
    // Pacing counts the voiceover's long pause.
    expect(pacing(p, tr).pauses.some((x) => x.clipId === "v1")).toBe(true);
  });
});
