import { describe, expect, it } from "vitest";
import { applyTransaction, compile, coverScale, createProject, fillSettings, type Op, type Project, type Transaction } from "../src/index.js";

const S = 1_000_000;
let n = 0;
const opts = { newId: (prefix: string) => `${prefix}${++n}` };
const tx = (p: Project, ops: Op[]): Transaction => ({ id: `tx${++n}`, baseRevision: p.revision, by: "user", summary: "test", ops });
const run = (p: Project, ...ops: Op[]) => applyTransaction(p, tx(p, ops), opts).project;

function wideProject(): Project {
  const p = createProject();
  return run(
    p,
    { op: "media.add", media: { id: "m1", path: "/raw/take.mp4", kind: "video", durationUs: 30 * S, probe: { hasVideo: true, hasAudio: true, width: 1920, height: 1080, fps: 60 } } },
    { op: "clip.add", trackId: "main", mediaId: "m1", id: "c1" },
  );
}

describe("timeline frame size", () => {
  it("starts new projects and new timelines at 16:9, filling", () => {
    const p = wideProject();
    expect([p.settings.width, p.settings.height, p.settings.frameFit]).toEqual([1920, 1080, "fill"]);
    const q = run(run(p, { op: "timeline.size", width: 1080, height: 1920 }), { op: "timeline.add", name: "Next" });
    expect([q.settings.width, q.settings.height]).toEqual([1920, 1080]);
  });

  it("keeps each timeline's own size when switching between them", () => {
    let p = wideProject();
    const main = p.timelineId!;
    p = run(p, { op: "timeline.add", name: "Short", id: "short" }, { op: "timeline.size", width: 1080, height: 1920 });
    p = run(p, { op: "timeline.switch", timelineId: main });
    expect([p.settings.width, p.settings.height]).toEqual([1920, 1080]);
    expect(p.timelines!.find((t) => t.id === "short")!.size).toEqual({ width: 1080, height: 1920, frameFit: "fill" });
    p = run(p, { op: "timeline.switch", timelineId: "short" });
    expect([p.settings.width, p.settings.height]).toEqual([1080, 1920]);
    expect(compile(p).width).toBe(1080);
  });

  it("covers a tall frame with a wide recording, unless set to fit or placed by hand", () => {
    let p = run(wideProject(), { op: "timeline.size", width: 1080, height: 1920 });
    const cover = coverScale(16 / 9, 9 / 16);
    expect(cover).toBeCloseTo(3.1605, 3);
    expect(compile(p).segments[0]!.transform!.scale).toBeCloseTo(cover, 6);
    // Stored transform is untouched, so going back to 16:9 shows it full frame again.
    expect(p.items.c1!.type === "clip" && p.items.c1.transform.scale).toBe(1);
    expect(compile(run(p, { op: "timeline.size", width: 1920, height: 1080 })).segments[0]!.transform!.scale).toBe(1);
    expect(compile(run(p, { op: "timeline.size", width: 1080, height: 1920, frameFit: "fit" })).segments[0]!.transform!.scale).toBe(1);
    p = run(p, { op: "clip.set", clipId: "c1", transform: { scale: 3.2, x: 0.3 } });
    expect(compile(p).segments[0]!.transform).toMatchObject({ scale: 3.2, x: 0.3 });
  });

  it("leaves projects from before timelines had a size showing recordings whole", () => {
    const old = wideProject();
    delete (old.settings as Partial<Project["settings"]>).frameFit;
    expect(fillSettings(old).settings.frameFit).toBe("fit");
  });

  it("refuses sizes an encoder can't take", () => {
    const p = wideProject();
    expect(() => run(p, { op: "timeline.size", width: 1081, height: 1920 })).toThrow(/even/);
    expect(() => run(p, { op: "timeline.size", width: 8, height: 1920 })).toThrow(/between/);
  });
});
