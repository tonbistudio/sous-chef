import { describe, expect, it } from "vitest";
import { applyTransaction, compile, createProject, type Op, type Project } from "../src/index";

const S = 1_000_000;
let n = 0;
function apply(p: Project, ops: Op[]): Project {
  return applyTransaction(p, { id: `t${++n}`, baseRevision: p.revision, by: "user", summary: "", ops }, { newId: (x) => `${x}${++n}` }).project;
}

/** Three 6 s clips of one recording, end to end on the main track. */
function three(): Project {
  return apply(createProject(), [
    { op: "media.add", media: { id: "m1", path: "a.mp4", kind: "video", durationUs: 600 * S, probe: { hasVideo: true, hasAudio: true } } as never },
    { op: "clip.add", trackId: "main", mediaId: "m1", id: "a", sourceInUs: 10 * S, sourceOutUs: 16 * S },
    { op: "clip.add", trackId: "main", mediaId: "m1", id: "b", sourceInUs: 100 * S, sourceOutUs: 106 * S },
    { op: "clip.add", trackId: "main", mediaId: "m1", id: "c", sourceInUs: 200 * S, sourceOutUs: 202 * S },
  ]);
}

describe("transitions", () => {
  it("puts a transition on the first piece of a clip that touches the one before, without changing the length", () => {
    const p = three();
    const before = compile(p).durationUs;
    const q = apply(p, [{ op: "clip.set", clipId: "b", transitionIn: { kind: "dissolve", durationUs: 1 * S } }]);
    const plan = compile(q);
    expect(plan.durationUs).toBe(before);
    const b = plan.segments.find((s) => s.clipId === "b")!;
    expect(b.transitionIn).toEqual({ kind: "dissolve", durationUs: 1 * S });
    expect(plan.segments.find((s) => s.clipId === "a")!.transitionIn).toBeUndefined();
  });

  it("limits a transition to half of the shorter piece next to the cut", () => {
    // Clip c is 2 s long, so at most 1 s on each side: a 4 s transition becomes 2 s.
    const q = apply(three(), [{ op: "clip.set", clipId: "c", transitionIn: { kind: "wipe", durationUs: 4 * S } }]);
    expect(compile(q).segments.find((s) => s.clipId === "c")!.transitionIn!.durationUs).toBe(2 * S);
  });

  it("has nothing to blend with after a gap, and can be removed", () => {
    let q = apply(three(), [{ op: "clip.set", clipId: "b", transitionIn: { kind: "white", durationUs: 600_000 } }]);
    // Moving b away leaves a gap before it: the transition is kept on the clip but not drawn.
    q = apply(q, [{ op: "clip.move", clipId: "b", startUs: 8 * S } as never]);
    expect(compile(q).segments.find((s) => s.clipId === "b")!.transitionIn).toBeUndefined();
    q = apply(q, [{ op: "clip.set", clipId: "b", transitionIn: null }]);
    expect((q.items.b as { transitionIn?: unknown }).transitionIn).toBeUndefined();
  });

  it("takes a transition on a cut inside a clip by splitting there, without changing the picture or the length", () => {
    // One clip with a stretch cut out of it: one cut, inside the clip.
    let q = apply(three(), [{ op: "range.remove", clipId: "a", startUs: 12 * S, endUs: 13 * S } as never]);
    const before = compile(q);
    const later = before.segments.find((s) => s.clipId === "a" && s.afterCut)!;
    q = apply(q, [
      { op: "clip.split", clipId: "a", atSourceUs: later.srcInUs, newId: "a2" } as never,
      { op: "clip.set", clipId: "a2", transitionIn: { kind: "dissolve", durationUs: 800_000 } },
    ]);
    const after = compile(q);
    expect(after.durationUs).toBe(before.durationUs);
    const seg = after.segments.find((s) => s.clipId === "a2")!;
    expect(seg.tlStartUs).toBe(later.tlStartUs);
    expect(seg.srcInUs).toBe(later.srcInUs);
    expect(seg.transitionIn).toEqual({ kind: "dissolve", durationUs: 800_000 });
  });

  it("refuses unknown kinds, silly lengths and clips off the main track", () => {
    const p = three();
    expect(() => apply(p, [{ op: "clip.set", clipId: "b", transitionIn: { kind: "spin" as never, durationUs: S } }])).toThrow(/kind/);
    expect(() => apply(p, [{ op: "clip.set", clipId: "b", transitionIn: { kind: "dissolve", durationUs: 10 * S } }])).toThrow(/between/);
    const withPic = apply(p, [
      { op: "media.add", media: { id: "p", path: "p.png", kind: "image", durationUs: 0, probe: { hasVideo: true, hasAudio: false } } as never },
      { op: "track.add", kind: "video", id: "v1" } as never,
      { op: "clip.add", trackId: "v1", mediaId: "p", id: "pic", startUs: 0, sourceInUs: 0, sourceOutUs: 3 * S },
    ]);
    expect(() => apply(withPic, [{ op: "clip.set", clipId: "pic", transitionIn: { kind: "dissolve", durationUs: S } }])).toThrow(/main track/);
  });
});
