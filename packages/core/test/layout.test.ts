import { describe, expect, it } from "vitest";
import { applyTransaction, compile, createProject, upgradeProject, type Clip, type Op, type Project } from "../src/index";

const S = 1_000_000;
let n = 0;
const apply = (p: Project, ops: Op[]) => applyTransaction(p, { id: `t${++n}`, baseRevision: p.revision, by: "user", summary: "", ops }, { newId: (x) => `${x}${++n}` }).project;
const media = (id: string, s: number) => ({ op: "media.add" as const, media: { id, path: `${id}.mp4`, kind: "video" as const, durationUs: s * S, probe: { hasVideo: true, hasAudio: true } } });
const starts = (p: Project) => (p.tracks[0]!.items.map((id) => [id, (p.items[id] as Clip).startUs / S]));

function three(): Project {
  return apply(createProject(), [
    media("m1", 10), media("m2", 10), media("m3", 10),
    { op: "clip.add", trackId: "main", mediaId: "m1", id: "a" },
    { op: "clip.add", trackId: "main", mediaId: "m2", id: "b" },
    { op: "clip.add", trackId: "main", mediaId: "m3", id: "c" },
  ]);
}

describe("main track with free placement", () => {
  it("adds clips end to end by default", () => {
    expect(starts(three())).toEqual([["a", 0], ["b", 10], ["c", 20]]);
  });

  it("leaves a gap when a clip is deleted, and closes it on request", () => {
    let p = apply(three(), [{ op: "clip.remove", clipId: "b" }]);
    expect(starts(p)).toEqual([["a", 0], ["c", 20]]);
    expect(compile(p).durationUs).toBe(30 * S);
    p = apply(p, [{ op: "gap.close", atUs: 15 * S }]);
    expect(starts(p)).toEqual([["a", 0], ["c", 10]]);
  });

  it("lets a clip sit anywhere, and closes every gap at once", () => {
    let p = apply(three(), [{ op: "clip.move", clipId: "c", startUs: 45 * S }]);
    expect(starts(p)).toEqual([["a", 0], ["b", 10], ["c", 45]]);
    p = apply(p, [{ op: "clip.move", clipId: "a", startUs: 3 * S }]);
    // a now runs 3..13 and pushes b, which started at 10, to 13.
    expect(starts(p)).toEqual([["a", 3], ["b", 13], ["c", 45]]);
    p = apply(p, [{ op: "gap.close" }]);
    expect(starts(p)).toEqual([["a", 0], ["b", 10], ["c", 20]]);
  });

  it("drops a clip onto another at the nearer edge and moves the rest along", () => {
    // c dropped a little into b goes in before b.
    let p = apply(three(), [{ op: "clip.move", clipId: "c", startUs: 12 * S }]);
    expect(starts(p)).toEqual([["a", 0], ["c", 10], ["b", 20]]);
    // a dropped near the end of b goes in after it, leaving the space a came from.
    p = apply(three(), [{ op: "clip.move", clipId: "a", startUs: 18 * S }]);
    expect(starts(p)).toEqual([["b", 10], ["a", 20], ["c", 30]]);
  });

  it("still reorders by position, closing the space left behind", () => {
    const p = apply(three(), [{ op: "clip.move", clipId: "c", index: 0 }]);
    expect(starts(p)).toEqual([["c", 0], ["a", 10], ["b", 20]]);
  });

  it("keeps later clips following when words are cut or restored, gaps included", () => {
    let p = apply(three(), [{ op: "clip.move", clipId: "c", startUs: 25 * S }]);
    p = apply(p, [{ op: "range.remove", clipId: "a", startUs: 2 * S, endUs: 4 * S, id: "r1" }]);
    expect(starts(p)).toEqual([["a", 0], ["b", 8], ["c", 23]]);
    p = apply(p, [{ op: "range.restore", clipId: "a", rangeIds: ["r1"] }]);
    expect(starts(p)).toEqual([["a", 0], ["b", 10], ["c", 25]]);
  });

  it("splits in place and trims without moving what is left", () => {
    let p = apply(three(), [{ op: "clip.split", clipId: "b", atSourceUs: 4 * S, newId: "b2" }]);
    expect(starts(p)).toEqual([["a", 0], ["b", 10], ["b2", 14], ["c", 20]]);
    // Trimming 2 s off the front of b2: it now starts at 16, and c stays put.
    p = apply(p, [{ op: "clip.trim", clipId: "b2", sourceInUs: 6 * S }]);
    expect(starts(p)).toEqual([["a", 0], ["b", 10], ["b2", 16], ["c", 20]]);
    // Trimming the end of a leaves a gap rather than pulling b left.
    p = apply(p, [{ op: "clip.trim", clipId: "a", sourceOutUs: 7 * S }]);
    expect(starts(p)).toEqual([["a", 0], ["b", 10], ["b2", 16], ["c", 20]]);
  });

  it("lays out a project from before clips had start times exactly as it played", () => {
    const old = three();
    delete old.freeMain;
    for (const id of old.tracks[0]!.items) (old.items[id] as Clip).startUs = 0;
    expect(compile(old).segments.map((s) => s.tlStartUs / S)).toEqual([0, 10, 20]);
    expect(starts(upgradeProject(old))).toEqual([["a", 0], ["b", 10], ["c", 20]]);
  });
});

describe("timelines", () => {
  it("keeps each timeline's contents apart and switches between them", () => {
    let p = apply(three(), [{ op: "timeline.add", name: "Intro", id: "tl2" }]);
    expect([p.timelineId, p.timelineName, p.tracks[0]!.items.length, p.timelineOrder]).toEqual(["tl2", "Intro", 0, ["tl1", "tl2"]]);
    p = apply(p, [{ op: "clip.add", trackId: "main", mediaId: "m1", sourceOutUs: 4 * S, id: "x" }]);
    p = apply(p, [{ op: "timeline.switch", timelineId: "tl1" }]);
    expect(p.tracks[0]!.items).toEqual(["a", "b", "c"]);
    expect(p.timelines!.map((t) => [t.id, t.tracks[0]!.items])).toEqual([["tl2", ["x"]]]);
  });

  it("drops a whole timeline into another, with its overlays, moving later content right", () => {
    let p = apply(three(), [{ op: "overlay.add", kind: "text", startUs: 12 * S, durationUs: 2 * S, text: "late", id: "o1" }, { op: "timeline.add", name: "Intro", id: "tl2" }]);
    p = apply(p, [
      { op: "clip.add", trackId: "main", mediaId: "m1", sourceOutUs: 4 * S, id: "x" },
      { op: "overlay.add", kind: "text", startUs: 1 * S, durationUs: 2 * S, text: "hello" },
      { op: "track.add", kind: "audio", id: "au" },
      { op: "clip.add", trackId: "au", mediaId: "m2", sourceOutUs: 3 * S, startUs: 0 },
      { op: "marker.add", timeUs: 2 * S, label: "beat" },
      { op: "timeline.switch", timelineId: "tl1" },
    ]);
    p = apply(p, [{ op: "timeline.insert", timelineId: "tl2", atUs: 10 * S }]);
    const plan = compile(p);
    // a, then the 4 s intro, then b and c four seconds later than before.
    expect(plan.segments.filter((s) => s.trackKind === "main").map((s) => [s.mediaId, s.tlStartUs / S])).toEqual([["m1", 0], ["m1", 10], ["m2", 14], ["m3", 24]]);
    expect(plan.overlays.map((o) => [o.text, o.tlStartUs / S])).toEqual([["hello", 11], ["late", 16]]);
    expect(plan.segments.filter((s) => s.trackKind === "audio").map((s) => s.tlStartUs / S)).toEqual([10]);
    expect(p.markers.map((m) => [m.label, m.timeUs / S])).toEqual([["beat", 12]]);
    // The source timeline is still there, untouched.
    expect(p.timelines!.find((t) => t.id === "tl2")!.tracks[0]!.items).toEqual(["x"]);
  });

  it("will not remove the last timeline or insert one into itself", () => {
    const p = three();
    expect(() => apply(p, [{ op: "timeline.remove", timelineId: "tl1" }])).toThrow();
    expect(() => apply(p, [{ op: "timeline.insert", timelineId: "tl1" }])).toThrow();
  });

  it("speeds the main track up and keeps text, music and markers with the same moment", () => {
    let p = apply(three(), [
      { op: "track.add", kind: "audio", id: "mus", name: "Music" },
      { op: "clip.add", trackId: "mus", mediaId: "m1", startUs: 11 * S, id: "music" },
      { op: "overlay.add", kind: "text", text: "Hi", startUs: 22 * S, durationUs: 2.2 * S, id: "t1" } as never,
      { op: "marker.add", timeUs: 11 * S, id: "k1" },
      { op: "clip.remove", clipId: "b" },
    ]);
    p = apply(p, [{ op: "project.speed", speed: 1.1 }]);
    const plan = compile(p);
    // Two 10 s clips at 1.1x with the 10 s gap between them: everything is 1/1.1 as long.
    expect(starts(p)).toEqual([["a", 0], ["c", Math.round((20 * S) / 1.1) / S]]);
    expect(plan.durationUs).toBeCloseTo((30 * S) / 1.1, -2);
    expect((p.items.a as Clip).speed).toBe(1.1);
    expect((p.items.music as Clip).speed).toBe(1);
    expect((p.items.music as Clip).startUs).toBe(10 * S);
    expect(p.items.t1).toMatchObject({ startUs: 20 * S, durationUs: 2 * S });
    expect(p.markers[0]!.timeUs).toBe(10 * S);
    // New main clips come in at the project speed, and changing it back restores the layout.
    p = apply(p, [{ op: "clip.add", trackId: "main", mediaId: "m2", id: "d" }]);
    expect((p.items.d as Clip).speed).toBe(1.1);
    p = apply(p, [{ op: "project.speed", speed: 1 }]);
    expect(starts(p).slice(0, 2)).toEqual([["a", 0], ["c", 20]]);
    expect(p.items.t1).toMatchObject({ startUs: 22 * S, durationUs: 2.2 * S });
    expect(() => apply(p, [{ op: "settings.set", settings: { mainSpeed: 2 } } as never])).toThrow(/project.speed/);
    expect(createProject({ mainSpeed: 1.1 }).settings.mainSpeed).toBe(1.1);
  });
});
