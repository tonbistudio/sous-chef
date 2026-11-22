import { describe, expect, it } from "vitest";
import { applyTransaction, createProject, Session, type Op, type Project, type Transaction } from "../src/index.js";

const S = 1_000_000;
let n = 0;
const opts = { newId: (prefix: string) => `${prefix}${++n}` };
const tx = (p: Project, ops: Op[]): Transaction => ({ id: `tx${++n}`, baseRevision: p.revision, by: "user", summary: "t", ops });
const run = (p: Project, ...ops: Op[]) => applyTransaction(p, tx(p, ops), opts).project;
const kinds = (p: Project) => p.tracks.map((t) => t.kind);

function project(): Project {
  return run(
    createProject(),
    { op: "media.add", media: { id: "m1", path: "/raw/take.mp4", kind: "video", durationUs: 30 * S, probe: { hasVideo: true, hasAudio: true, width: 1920, height: 1080, fps: 60 } } },
    { op: "media.add", media: { id: "m2", path: "/raw/pip.mp4", kind: "video", durationUs: 5 * S, probe: { hasVideo: true, hasAudio: true, width: 1920, height: 1080, fps: 60 } } },
    { op: "clip.add", trackId: "main", mediaId: "m1", id: "c1" },
  );
}

describe("lanes", () => {
  it("removes an overlay video lane with its last clip, and undo brings it back", () => {
    let p = run(project(), { op: "track.add", kind: "video", id: "v1" }, { op: "clip.add", trackId: "v1", mediaId: "m2", id: "c2", startUs: 2 * S });
    expect(kinds(p)).toEqual(["main", "video"]);
    const res = applyTransaction(p, tx(p, [{ op: "clip.remove", clipId: "c2" }]), opts);
    expect(kinds(res.project)).toEqual(["main"]);
    // Undo is the inverse patch.
    const s = new Session(p);
    s.apply(tx(p, [{ op: "clip.remove", clipId: "c2" }]), opts);
    expect(kinds(s.project)).toEqual(["main"]);
    s.undo();
    expect(kinds(s.project)).toEqual(["main", "video"]);
    expect(s.project.items.c2).toBeDefined();
  });

  it("keeps a lane that still has something on it, and one just added empty", () => {
    let p = run(project(), { op: "track.add", kind: "video", id: "v1" }, { op: "clip.add", trackId: "v1", mediaId: "m2", id: "c2" }, { op: "clip.add", trackId: "v1", mediaId: "m2", id: "c3", startUs: 10 * S });
    p = run(p, { op: "clip.remove", clipId: "c2" });
    expect(kinds(p)).toEqual(["main", "video"]);
    p = run(p, { op: "track.add", kind: "audio", id: "a1" });
    expect(kinds(p)).toEqual(["main", "video", "audio"]);
  });

  it("removes the text and graphics lane with its last overlay", () => {
    let p = run(project(), { op: "overlay.add", kind: "text", startUs: 0, durationUs: S, text: "Hi" });
    expect(kinds(p)).toContain("overlay");
    const id = Object.values(p.items).find((i) => i.type === "overlay")!.id;
    p = run(p, { op: "overlay.remove", overlayId: id });
    expect(kinds(p)).toEqual(["main"]);
  });
});
