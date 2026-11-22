import { describe, expect, it } from "vitest";
import { applyTransaction, captureTemplate, compile, createProject, type Clip, type Op, type Project } from "../src/index";

const S = 1_000_000;
let n = 0;
const apply = (p: Project, ops: Op[]) => applyTransaction(p, { id: `t${++n}`, baseRevision: p.revision, by: "user", summary: "", ops }, { newId: (x) => `${x}${++n}` }).project;
const video = (id: string, s: number) => ({ op: "media.add" as const, media: { id, path: `${id}.mp4`, kind: "video" as const, durationUs: s * S, probe: { hasVideo: true, hasAudio: true } } });
const picture = (id: string) => ({ op: "media.add" as const, media: { id, path: `${id}.png`, kind: "image" as const, durationUs: 0, probe: { hasVideo: true, hasAudio: false } } });

describe("templates", () => {
  it("captures text, pictures and graphics from a stretch and drops them into another project without moving anything", () => {
    const made = apply(createProject(), [
      video("take", 30), picture("logo"),
      { op: "clip.add", trackId: "main", mediaId: "take", id: "c1" },
      { op: "track.add", kind: "video", id: "pics", name: "Pictures" },
      { op: "clip.add", trackId: "pics", mediaId: "logo", startUs: 11 * S, id: "p1" },
      { op: "overlay.add", kind: "text", text: "Chapter", startUs: 10 * S, durationUs: 3 * S, id: "o1" } as never,
      { op: "overlay.add", kind: "text", text: "Elsewhere", startUs: 25 * S, durationUs: 2 * S, id: "o2" } as never,
    ]);
    const cap = captureTemplate(made, 10 * S, 15 * S, "Chapter card");
    expect(cap.hasMain).toBe(false);
    expect(cap.contents).toBe("1 picture, 1 text");
    expect(cap.mediaIds).toEqual(["logo"]);
    expect(cap.lengthUs).toBe(5 * S + 1 * S);

    let other = apply(createProject(), [video("take2", 60), picture("logo"), { op: "clip.add", trackId: "main", mediaId: "take2", id: "m1" }]);
    const before = compile(other).durationUs;
    other = apply(other, [{ op: "template.insert", template: cap.body, atUs: 40 * S }]);
    expect(compile(other).durationUs).toBe(before);
    const texts = Object.values(other.items).filter((i) => i.type === "overlay");
    expect(texts.map((t) => [t.type === "overlay" && t.text, t.startUs])).toEqual([["Chapter", 40 * S]]);
    const pics = Object.values(other.items).filter((i) => i.type === "clip" && i.mediaId === "logo") as Clip[];
    expect(pics.map((c) => c.startUs)).toEqual([41 * S]);
  });

  it("inserts a template with main clips by making room, at the project's speed", () => {
    const made = apply(createProject(), [video("intro", 4), { op: "clip.add", trackId: "main", mediaId: "intro", id: "i1" }]);
    const cap = captureTemplate(made, 0, 4 * S, "Intro");
    expect(cap.hasMain).toBe(true);
    let p = apply(createProject({ mainSpeed: 2 }), [video("intro", 4), video("take", 10), { op: "clip.add", trackId: "main", mediaId: "take", id: "t1" }]);
    p = apply(p, [{ op: "template.insert", template: cap.body, atUs: 0 }]);
    const clips = p.tracks[0]!.items.map((id) => p.items[id] as Clip);
    // The 4 s intro plays at 2x (2 s) and the take moves right by that much.
    expect(clips.map((c) => [c.mediaId, c.startUs, c.speed])).toEqual([["intro", 0, 2], ["take", 2 * S, 2]]);
    expect(() => apply(p, [{ op: "template.insert", template: { name: "x", mainSpeed: 1, tracks: [], markers: [] } }])).toThrow(/empty/);
  });
});
