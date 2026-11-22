import { describe, expect, it } from "vitest";
import {
  EditError,
  Session,
  applyTransaction,
  clipDurationUs,
  compile,
  createProject,
  keptRanges,
  sourceToTimeline,
  timelineToSource,
  type Clip,
  type Op,
  type Project,
  type Transaction,
} from "../src/index.js";

const S = 1_000_000;

function ids() {
  let n = 0;
  return { newId: (prefix: string) => `${prefix}${++n}` };
}

let txCount = 0;
function tx(project: Project, ops: Op[], by: "user" | "agent" = "user"): Transaction {
  return { id: `tx${++txCount}`, baseRevision: project.revision, by, summary: "test", ops };
}

const video = (durationS: number) => ({
  path: "/media/raw/take.mp4",
  kind: "video" as const,
  durationUs: durationS * S,
  probe: { hasVideo: true, hasAudio: true, width: 1920, height: 1080, fps: 60 },
});

function withClip(durationS = 60) {
  const opts = ids();
  let p = createProject();
  p = applyTransaction(
    p,
    tx(p, [
      { op: "media.add", media: { ...video(durationS), id: "m1" } },
      { op: "clip.add", trackId: "main", mediaId: "m1", id: "c1" },
    ]),
    opts,
  ).project;
  return { p, opts };
}

function expectError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(EditError);
    expect((err as EditError).code).toBe(code);
    return;
  }
  throw new Error(`expected an EditError with code ${code}`);
}

describe("transactions", () => {
  it("adds media and a clip covering the whole file", () => {
    const { p } = withClip(60);
    expect(p.revision).toBe(1);
    const clip = p.items.c1 as Clip;
    expect([clip.sourceInUs, clip.sourceOutUs]).toEqual([0, 60 * S]);
    expect(p.tracks[0]!.items).toEqual(["c1"]);
  });

  it("does not modify the input project", () => {
    const { p, opts } = withClip();
    const before = JSON.stringify(p);
    applyTransaction(p, tx(p, [{ op: "clip.trim", clipId: "c1", sourceInUs: 5 * S }]), opts);
    expect(JSON.stringify(p)).toBe(before);
  });

  it("rejects a stale base revision", () => {
    const { p, opts } = withClip();
    const stale = { ...tx(p, [{ op: "clip.remove", clipId: "c1" }]), baseRevision: 0 };
    expectError(() => applyTransaction(p, stale, opts), "stale_revision");
  });

  it("applies all ops or none", () => {
    const { p, opts } = withClip();
    expectError(
      () =>
        applyTransaction(
          p,
          tx(p, [
            { op: "clip.trim", clipId: "c1", sourceInUs: 5 * S },
            { op: "clip.remove", clipId: "nope" },
          ]),
          opts,
        ),
      "not_found",
    );
    expect((p.items.c1 as Clip).sourceInUs).toBe(0);
  });

  it("validates ranges, ids and track rules", () => {
    const { p, opts } = withClip(60);
    expectError(() => applyTransaction(p, tx(p, [{ op: "clip.trim", clipId: "c1", sourceOutUs: 61 * S }]), opts), "invalid");
    expectError(() => applyTransaction(p, tx(p, [{ op: "clip.trim", clipId: "c1", sourceInUs: 1.5 }]), opts), "invalid");
    expectError(() => applyTransaction(p, tx(p, [{ op: "clip.add", trackId: "main", mediaId: "m1", id: "c1" }]), opts), "conflict");
    expectError(() => applyTransaction(p, tx(p, [{ op: "media.remove", mediaId: "m1" }]), opts), "conflict");
    expectError(() => applyTransaction(p, tx(p, [{ op: "track.remove", trackId: "main" }]), opts), "invalid");
    expectError(
      () => applyTransaction(p, tx(p, [{ op: "zoom.add", mediaId: "m1", startUs: 0, endUs: S, rect: [0.8, 0, 0.5, 0.5] }]), opts),
      "invalid",
    );
    expectError(() => applyTransaction(p, tx(p, [{ op: "bogus" } as unknown as Op]), opts), "invalid");
  });

  it("rejects overlapping clips on a free track", () => {
    const { p, opts } = withClip(60);
    const p2 = applyTransaction(
      p,
      tx(p, [
        { op: "track.add", kind: "video", id: "v2" },
        { op: "clip.add", trackId: "v2", mediaId: "m1", sourceOutUs: 10 * S, startUs: 0 },
      ]),
      opts,
    ).project;
    expectError(
      () => applyTransaction(p2, tx(p2, [{ op: "clip.add", trackId: "v2", mediaId: "m1", sourceOutUs: 10 * S, startUs: 5 * S }]), opts),
      "conflict",
    );
  });

  it("splits a clip and divides its cuts between the halves", () => {
    const { p, opts } = withClip(60);
    const p2 = applyTransaction(
      p,
      tx(p, [
        { op: "range.remove", clipId: "c1", startUs: 5 * S, endUs: 6 * S },
        { op: "range.remove", clipId: "c1", startUs: 29 * S, endUs: 31 * S },
        { op: "range.remove", clipId: "c1", startUs: 50 * S, endUs: 51 * S },
        { op: "clip.split", clipId: "c1", atSourceUs: 30 * S, newId: "c2" },
      ]),
      opts,
    ).project;
    const a = p2.items.c1 as Clip;
    const b = p2.items.c2 as Clip;
    expect(p2.tracks[0]!.items).toEqual(["c1", "c2"]);
    expect([a.sourceInUs, a.sourceOutUs, b.sourceInUs, b.sourceOutUs]).toEqual([0, 30 * S, 30 * S, 60 * S]);
    expect(a.removed.map((r) => [r.startUs, r.endUs])).toEqual([[5 * S, 6 * S], [29 * S, 30 * S]]);
    expect(b.removed.map((r) => [r.startUs, r.endUs])).toEqual([[30 * S, 31 * S], [50 * S, 51 * S]]);
    // The split must not change what plays.
    expect(compile(p2).durationUs).toBe(56 * S);
  });

  it("records who made a cut", () => {
    const { p, opts } = withClip();
    const p2 = applyTransaction(p, tx(p, [{ op: "range.remove", clipId: "c1", startUs: S, endUs: 2 * S, why: "silence" }], "agent"), opts).project;
    expect((p2.items.c1 as Clip).removed[0]).toMatchObject({ by: "agent", why: "silence" });
  });
});

describe("compile", () => {
  it("closes the gap when a range is removed and restores it exactly", () => {
    const { p, opts } = withClip(60);
    const cut = applyTransaction(p, tx(p, [{ op: "range.remove", clipId: "c1", startUs: 10 * S, endUs: 15 * S, id: "r1" }]), opts).project;
    const plan = compile(cut);
    expect(plan.durationUs).toBe(55 * S);
    expect(plan.segments.map((s) => [s.srcInUs, s.srcOutUs, s.tlStartUs, s.tlEndUs])).toEqual([
      [0, 10 * S, 0, 10 * S],
      [15 * S, 60 * S, 10 * S, 55 * S],
    ]);
    expect(plan.segments.map((s) => s.afterCut)).toEqual([false, true]);
    const restored = applyTransaction(cut, tx(cut, [{ op: "range.restore", clipId: "c1", rangeIds: ["r1"] }]), opts).project;
    expect(compile(restored).segments).toHaveLength(1);
    expect(compile(restored).durationUs).toBe(60 * S);
  });

  it("narrows padded cuts by the project padding", () => {
    const { p, opts } = withClip(60);
    const cut = applyTransaction(p, tx(p, [{ op: "range.remove", clipId: "c1", startUs: 10 * S, endUs: 15 * S, pad: true }]), opts).project;
    expect(keptRanges(cut.items.c1 as Clip, cut.settings.cut)).toEqual([
      [0, 10 * S + 100_000],
      [15 * S - 100_000, 60 * S],
    ]);
    // A padded cut shorter than the padding removes nothing.
    const tiny = applyTransaction(p, tx(p, [{ op: "range.remove", clipId: "c1", startUs: 10 * S, endUs: 10 * S + 150_000, pad: true }]), opts).project;
    expect(compile(tiny).durationUs).toBe(60 * S);
  });

  it("merges overlapping cuts and ignores cuts outside a trimmed clip", () => {
    const { p, opts } = withClip(60);
    const p2 = applyTransaction(
      p,
      tx(p, [
        { op: "range.remove", clipId: "c1", startUs: 10 * S, endUs: 20 * S },
        { op: "range.remove", clipId: "c1", startUs: 15 * S, endUs: 25 * S },
        { op: "range.remove", clipId: "c1", startUs: 50 * S, endUs: 55 * S },
        { op: "clip.trim", clipId: "c1", sourceOutUs: 40 * S },
      ]),
      opts,
    ).project;
    expect(keptRanges(p2.items.c1 as Clip, p2.settings.cut)).toEqual([
      [0, 10 * S],
      [25 * S, 40 * S],
    ]);
    expect(clipDurationUs(p2.items.c1 as Clip, p2.settings.cut)).toBe(25 * S);
  });

  it("lays main clips end to end in track order and honours speed", () => {
    const { p, opts } = withClip(60);
    const p2 = applyTransaction(
      p,
      tx(p, [
        { op: "clip.trim", clipId: "c1", sourceOutUs: 10 * S },
        { op: "clip.add", trackId: "main", mediaId: "m1", sourceInUs: 20 * S, sourceOutUs: 30 * S, id: "c2" },
        { op: "clip.set", clipId: "c2", speed: 2 },
        { op: "clip.move", clipId: "c2", index: 0 },
      ]),
      opts,
    ).project;
    const plan = compile(p2);
    expect(plan.segments.map((s) => [s.clipId, s.tlStartUs, s.tlEndUs])).toEqual([
      ["c2", 0, 5 * S],
      ["c1", 5 * S, 15 * S],
    ]);
    expect(sourceToTimeline(plan, "m1", 24 * S)).toBe(2 * S);
    expect(timelineToSource(plan, 7 * S)).toMatchObject({ srcUs: 2 * S });
    expect(sourceToTimeline(plan, "m1", 15 * S)).toBeNull();
  });

  it("keeps a zoom on its content when earlier words are cut, and joins it across a cut", () => {
    const { p, opts } = withClip(60);
    const zoomed = applyTransaction(
      p,
      tx(p, [{ op: "zoom.add", mediaId: "m1", startUs: 30 * S, endUs: 40 * S, rect: [0.25, 0.25, 0.5, 0.5], id: "z1" }]),
      opts,
    ).project;
    expect(compile(zoomed).camera).toMatchObject([{ zoomId: "z1", tlStartUs: 30 * S, tlEndUs: 40 * S, inUs: 1_500_000, maxScale: 2 }]);

    const earlierCut = applyTransaction(zoomed, tx(zoomed, [{ op: "range.remove", clipId: "c1", startUs: 5 * S, endUs: 10 * S }]), opts).project;
    expect(compile(earlierCut).camera).toMatchObject([{ tlStartUs: 25 * S, tlEndUs: 35 * S }]);

    const insideCut = applyTransaction(zoomed, tx(zoomed, [{ op: "range.remove", clipId: "c1", startUs: 33 * S, endUs: 35 * S }]), opts).project;
    expect(compile(insideCut).camera).toMatchObject([{ tlStartUs: 30 * S, tlEndUs: 38 * S }]);

    const swallowed = applyTransaction(zoomed, tx(zoomed, [{ op: "range.remove", clipId: "c1", startUs: 29 * S, endUs: 41 * S, id: "big" }]), opts).project;
    expect(compile(swallowed).camera).toEqual([]);
    expect(swallowed.items.z1).toBeDefined();
  });
});

describe("history", () => {
  it("undoes and redoes back to identical state", () => {
    const { p, opts } = withClip(60);
    const session = new Session(p, opts);
    const original = JSON.stringify({ ...p, revision: 0 });
    session.apply(tx(session.project, [{ op: "range.remove", clipId: "c1", startUs: 10 * S, endUs: 15 * S }]));
    session.apply(tx(session.project, [{ op: "clip.split", clipId: "c1", atSourceUs: 30 * S }]));
    const edited = JSON.stringify({ ...session.project, revision: 0 });
    expect(session.project.revision).toBe(3);

    session.undo();
    session.undo();
    expect(JSON.stringify({ ...session.project, revision: 0 })).toBe(original);
    expect(session.project.revision).toBe(5);
    expect(session.canUndo).toBe(false);

    session.redo();
    session.redo();
    expect(JSON.stringify({ ...session.project, revision: 0 })).toBe(edited);
    expect(() => session.redo()).toThrow();
  });

  it("treats a repeated transaction id as a no-op", () => {
    const { p, opts } = withClip(60);
    const session = new Session(p, opts);
    const t = tx(session.project, [{ op: "range.remove", clipId: "c1", startUs: 10 * S, endUs: 15 * S }]);
    const first = session.apply(t);
    const again = session.apply(t);
    expect(first.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    expect(again.created).toEqual(first.created);
    expect(session.project.revision).toBe(2);
  });

  it("names, moves and undoes a marker", () => {
    const { p, opts } = withClip(60);
    const session = new Session(p, opts);
    session.apply(tx(session.project, [{ op: "marker.add", timeUs: 5 * S, id: "k1" }, { op: "marker.add", timeUs: 9 * S, id: "k2" }]));
    session.apply(tx(session.project, [{ op: "marker.update", markerId: "k1", label: "  Intro  ", timeUs: 12 * S }]));
    expect(session.project.markers.map((m) => [m.id, m.label, m.timeUs])).toEqual([["k2", "", 9 * S], ["k1", "Intro", 12 * S]]);
    session.undo();
    expect(session.project.markers.find((m) => m.id === "k1")).toMatchObject({ label: "", timeUs: 5 * S });
    expect(() => session.apply(tx(session.project, [{ op: "marker.update", markerId: "nope", label: "x" }]))).toThrow();
  });

  it("clears redo after a new edit and rebuilds stacks from saved records", () => {
    const { p, opts } = withClip(60);
    const session = new Session(p, opts);
    const records = [];
    records.push(session.apply(tx(session.project, [{ op: "marker.add", timeUs: S, id: "k1" }])).record!);
    records.push(session.apply(tx(session.project, [{ op: "marker.add", timeUs: 2 * S, id: "k2" }])).record!);
    records.push(session.undo().record);
    expect(session.canRedo).toBe(true);

    const reopened = new Session(session.project, opts);
    reopened.restore(records);
    expect(reopened.peek()).toEqual({ undo: "test", redo: "test" });
    reopened.redo();
    expect(reopened.project.markers.map((m) => m.id)).toEqual(["k1", "k2"]);

    session.apply(tx(session.project, [{ op: "marker.add", timeUs: 3 * S, id: "k3" }]));
    expect(session.canRedo).toBe(false);
  });
});

describe("relinking and other tracks", () => {
  it("points media at a moved file only when it is the same recording", () => {
    const { p, opts } = withClip(60);
    const moved = applyTransaction(p, tx(p, [{ op: "media.relink", mediaId: "m1", media: { ...video(60), path: "E:/moved/take.mp4" } }]), opts).project;
    expect(moved.media[0]!.path).toBe("E:/moved/take.mp4");
    expectError(() => applyTransaction(p, tx(p, [{ op: "media.relink", mediaId: "m1", media: { ...video(30), path: "E:/other.mp4" } }]), opts), "invalid");
  });

  it("places pictures on a video track for five seconds and keeps them off the main track", () => {
    const { p, opts } = withClip(60);
    const pic = { path: "/media/a.png", kind: "image" as const, durationUs: 0, probe: { hasVideo: true, hasAudio: false } };
    expectError(() => applyTransaction(p, tx(p, [{ op: "media.add", media: { ...pic, id: "i1" } }, { op: "clip.add", trackId: "main", mediaId: "i1" }]), opts), "invalid");
    const q = applyTransaction(p, tx(p, [
      { op: "media.add", media: { ...pic, id: "i1" } },
      { op: "track.add", kind: "video", id: "v1" },
      { op: "clip.add", trackId: "v1", mediaId: "i1", startUs: 2 * S, id: "c2" },
    ]), opts).project;
    const seg = compile(q).segments.find((s) => s.clipId === "c2")!;
    expect([seg.tlStartUs, seg.tlEndUs, seg.still, seg.hasAudio]).toEqual([2 * S, 7 * S, true, false]);
  });

  it("adds, edits and removes overlays, creating the overlay track when needed", () => {
    const { p, opts } = withClip(60);
    const r = applyTransaction(p, tx(p, [{ op: "overlay.add", kind: "text", startUs: S, durationUs: 2 * S, text: "Hi", id: "o1" }]), opts);
    expect(r.project.tracks.some((t) => t.kind === "overlay" && t.items.includes("o1"))).toBe(true);
    const plan = compile(r.project);
    expect(plan.overlays.map((o) => [o.tlStartUs, o.tlEndUs, o.text])).toEqual([[S, 3 * S, "Hi"]]);
    expectError(() => applyTransaction(r.project, tx(r.project, [{ op: "overlay.set", overlayId: "o1", style: { color: "red" } }]), opts), "invalid");
    expectError(() => applyTransaction(r.project, tx(r.project, [{ op: "overlay.add", kind: "hyperframes", template: "../evil", startUs: 0, durationUs: S }]), opts), "invalid");
    const gone = applyTransaction(r.project, tx(r.project, [{ op: "overlay.remove", overlayId: "o1" }]), opts).project;
    expect(compile(gone).overlays).toEqual([]);
  });
});
