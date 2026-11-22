import { applyTransaction, compile, createProject, type Op, type Project } from "@sous-chef/core";
import { describe, expect, it } from "vitest";
import { clipSpans, cutRangeOps, splitAtOp } from "../src/actions";

const S = 1_000_000;
let n = 0;
const opts = { newId: (p: string) => `${p}${++n}` };

function apply(p: Project, ops: Op[]): Project {
  return applyTransaction(p, { id: `t${++n}`, baseRevision: p.revision, by: "user", summary: "", ops }, opts).project;
}

function twoClips(): Project {
  return apply(createProject(), [
    { op: "media.add", media: { id: "m1", path: "a.mp4", kind: "video", durationUs: 60 * S, probe: { hasVideo: true, hasAudio: true } } },
    { op: "clip.add", trackId: "main", mediaId: "m1", sourceInUs: 0, sourceOutUs: 20 * S, id: "a" },
    { op: "clip.add", trackId: "main", mediaId: "m1", sourceInUs: 40 * S, sourceOutUs: 60 * S, id: "b" },
  ]);
}

describe("timeline actions", () => {
  it("cuts a marked range inside one clip and the timeline shortens by exactly that much", () => {
    const p = twoClips();
    const ops = cutRangeOps(compile(p), 5 * S, 8 * S);
    expect(ops).toEqual([{ op: "range.remove", clipId: "a", startUs: 5 * S, endUs: 8 * S }]);
    expect(compile(apply(p, ops)).durationUs).toBe(37 * S);
  });

  it("cuts across the join between two clips, in either drag direction", () => {
    const p = twoClips();
    const ops = cutRangeOps(compile(p), 25 * S, 18 * S);
    expect(ops).toEqual([
      { op: "range.remove", clipId: "a", startUs: 18 * S, endUs: 20 * S },
      { op: "range.remove", clipId: "b", startUs: 40 * S, endUs: 45 * S },
    ]);
    expect(compile(apply(p, ops)).durationUs).toBe(33 * S);
  });

  it("maps a second cut correctly after an earlier cut closed a gap", () => {
    const once = apply(twoClips(), [{ op: "range.remove", clipId: "a", startUs: 5 * S, endUs: 8 * S }]);
    // Timeline 6 s to 9 s is now source 9 s to 12 s of clip a.
    const ops = cutRangeOps(compile(once), 6 * S, 9 * S);
    expect(ops).toEqual([{ op: "range.remove", clipId: "a", startUs: 9 * S, endUs: 12 * S }]);
    // A range spanning the old cut covers source on both sides of it.
    expect(cutRangeOps(compile(once), 4 * S, 6 * S)).toEqual([{ op: "range.remove", clipId: "a", startUs: 4 * S, endUs: 9 * S }]);
  });

  it("splits under the playhead in source time and refuses at a clip edge", () => {
    const p = twoClips();
    const plan = compile(p);
    expect(splitAtOp(plan, 25 * S)).toEqual({ op: "clip.split", clipId: "b", atSourceUs: 45 * S });
    expect(splitAtOp(plan, 20 * S)).toBeNull();
    expect(splitAtOp(plan, 99 * S)).toBeNull();
    const split = apply(p, [splitAtOp(plan, 25 * S)!]);
    expect(compile(split).durationUs).toBe(40 * S);
  });

  it("reports each clip's span and where its cuts fall", () => {
    const p = apply(twoClips(), [{ op: "range.remove", clipId: "b", startUs: 45 * S, endUs: 50 * S }]);
    const spans = clipSpans(compile(p));
    expect(spans.get("a")).toEqual({ startUs: 0, endUs: 20 * S, cuts: [] });
    expect(spans.get("b")).toEqual({ startUs: 20 * S, endUs: 35 * S, cuts: [25 * S] });
  });
});
