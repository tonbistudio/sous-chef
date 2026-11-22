import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyTransaction, cameraAt, compile, createProject, type Op, type Project } from "@sous-chef/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Exporter, partArgs, partsOf, videoPieces, type ExportJob } from "../src/export";

const S = 1_000_000;
let dir: string;
let src: string;
let n = 0;

function project(ops: Op[]): Project {
  let p = createProject();
  p.settings.width = 320;
  p.settings.height = 180;
  p.settings.fps = 30;
  p = applyTransaction(p, { id: `t${++n}`, baseRevision: 0, by: "user", summary: "", ops }, { newId: (x) => `${x}${++n}` }).project;
  return p;
}

const base: Op[] = [
  { op: "media.add", media: { id: "m1", path: "src.mp4", kind: "video", durationUs: 6 * S, probe: { hasVideo: true, hasAudio: true } } as never },
  { op: "clip.add", trackId: "main", mediaId: "m1", id: "c1" },
];

function probe(file: string) {
  const out = execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]).toString();
  const j = JSON.parse(out);
  return { duration: Number(j.format.duration), streams: j.streams.map((s: any) => s.codec_name) as string[], width: j.streams.find((s: any) => s.width)?.width };
}

async function finish(ex: Exporter, job: ExportJob): Promise<ExportJob> {
  for (let i = 0; i < 600 && ex.get(job.id)!.state === "running"; i++) await new Promise((r) => setTimeout(r, 50));
  return ex.get(job.id)!;
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "sous-export-"));
  src = path.join(dir, "src.mp4");
  // Six seconds of moving test picture with a tone.
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=6", "-f", "lavfi", "-i", "sine=f=440:d=6", "-c:v", "libx264", "-preset", "ultrafast", "-g", "90", "-c:a", "aac", "-shortest", src]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("export", () => {
  it("gives every kept piece its own seeked input and one concat", () => {
    const plan = compile(project([...base, { op: "range.remove", clipId: "c1", startUs: 2 * S, endUs: 3 * S }]));
    const args = partArgs(plan, partsOf(plan)[0]!, () => "X.mp4", "out.mkv", { encoder: "libx264" });
    // Two pictures and two sounds; the sounds overlap at the cut and crossfade.
    expect(args.filter((a) => a === "-i")).toHaveLength(4);
    expect(args[args.indexOf("-ss") + 1]).toBe("0.000000");
    const graph = args.join(" ");
    expect(graph).toContain("concat=n=2:v=1:a=0");
    expect(graph).toMatch(/acrossfade=d=0.024[0-9]*:c1=qsin:c2=qsin/);
    expect(graph).not.toContain("amix");
  });

  it("renders a cut video of exactly the planned length", async () => {
    const plan = compile(project([...base, { op: "range.remove", clipId: "c1", startUs: 2 * S, endUs: 3.5 * S }]));
    expect(plan.durationUs).toBe(4.5 * S);
    const out = path.join(dir, "out", "cut.mp4");
    const ex = new Exporter();
    const job = await finish(ex, await ex.start("p", plan, () => src, out, "libx264"));
    expect(job.error).toBeUndefined();
    expect(job.state).toBe("done");
    const info = probe(out);
    expect(info.streams.sort()).toEqual(["aac", "h264"]);
    expect(info.width).toBe(320);
    expect(Math.abs(info.duration - 4.5)).toBeLessThan(0.06);
    expect(existsSync(path.join(dir, "out", `.export-${job.id}.mp4`))).toBe(false);
  }, 60_000);

  it("blends across a cut and dips to white without changing the length, even at the very ends of a take", async () => {
    // a: the last 2 s of the take, so the blend runs past its end; b: the first 2 s, so it starts before the take does.
    const plan = compile(project([
      { op: "media.add", media: { id: "m1", path: "src.mp4", kind: "video", durationUs: 6 * S, probe: { hasVideo: true, hasAudio: true } } as never },
      { op: "clip.add", trackId: "main", mediaId: "m1", id: "a", sourceInUs: 4 * S, sourceOutUs: 6 * S },
      { op: "clip.add", trackId: "main", mediaId: "m1", id: "b", sourceInUs: 0, sourceOutUs: 2 * S },
      { op: "clip.add", trackId: "main", mediaId: "m1", id: "c", sourceInUs: 2.5 * S, sourceOutUs: 4.5 * S },
      { op: "clip.set", clipId: "b", transitionIn: { kind: "dissolve", durationUs: 600_000 } },
      { op: "clip.set", clipId: "c", transitionIn: { kind: "white", durationUs: 600_000 } },
    ]));
    expect(plan.durationUs).toBe(6 * S);
    const graph = partArgs(plan, partsOf(plan)[0]!, () => src, "x.mkv", { encoder: "libx264" }).join(" ");
    // Each side runs 0.3 s past the cut, and the blend starts 0.6 s before the end of the first.
    expect(graph).toMatch(/xfade=transition=fade:duration=0\.6:offset=1\.7\b/);
    expect(graph).toContain("tpad=stop_mode=clone:stop_duration=0.3");
    expect(graph).toContain("tpad=start_mode=clone:start_duration=0.3");
    expect(graph).toMatch(/color=white:[^;]*fade=t=in:st=0:d=0\.3:alpha=1,fade=t=out:st=0\.3:d=0\.3:alpha=1/);
    const out = path.join(dir, "transitions.mp4");
    const ex = new Exporter();
    const job = await finish(ex, await ex.start("p", plan, () => src, out, "libx264"));
    expect(job.error).toBeUndefined();
    expect(Math.abs(probe(out).duration - 6)).toBeLessThan(0.06);
    // At the second cut the picture is white; half a second either side it is not.
    const level = (t: number) => {
      const raw = execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", out, "-frames:v", "1", "-vf", "scale=8:8,format=gray", "-f", "rawvideo", "pipe:1"]);
      return [...raw].reduce((a, b) => a + b, 0) / raw.length;
    };
    expect(level(4)).toBeGreaterThan(200);
    expect(level(3.5)).toBeLessThan(170);
    expect(level(4.5)).toBeLessThan(170);
  }, 60_000);

  it("renders a heavily cut video in parts and joins them to the same length", async () => {
    // 50 small cuts make 51 pieces, more than one part holds.
    const cuts: Op[] = Array.from({ length: 50 }, (_, i) => ({ op: "range.remove" as const, clipId: "c1", startUs: Math.round((0.1 + i * 0.11) * S), endUs: Math.round((0.14 + i * 0.11) * S) }));
    const plan = compile(project([...base, ...cuts]));
    expect(plan.segments.length).toBe(51);
    expect(partsOf(plan).length).toBe(2);
    const out = path.join(dir, "parts.mp4");
    const ex = new Exporter();
    const job = await finish(ex, await ex.start("p", plan, () => src, out, "libx264"));
    expect(job.error).toBeUndefined();
    expect(job.state).toBe("done");
    expect(Math.abs(probe(out).duration - plan.durationUs / S)).toBeLessThan(0.08);
  }, 120_000);

  it("counts clips on other tracks toward a part's input limit", () => {
    const S1 = 1_000_000;
    const main = Array.from({ length: 40 }, (_, i) => ({ trackKind: "main", tlStartUs: i * S1, tlEndUs: (i + 1) * S1, srcInUs: i * S1, srcOutUs: (i + 1) * S1, speed: 1, mediaId: "m", clipId: `c${i}`, hasVideo: true, hasAudio: true }));
    // Two sound clips under every main piece: 80 more inputs, which one part must not take on alone.
    const music = Array.from({ length: 80 }, (_, i) => ({ trackKind: "audio", tlStartUs: Math.floor(i / 2) * S1, tlEndUs: (Math.floor(i / 2) + 1) * S1, srcInUs: 0, srcOutUs: S1, speed: 1, mediaId: "a", clipId: `a${i}`, hasVideo: false, hasAudio: true, muted: false, still: false }));
    const plan = { fps: 30, width: 320, height: 180, durationUs: 40 * S1, audioFadeUs: 10_000, camera: [], overlays: [], segments: [...main, ...music] } as never;
    for (const part of partsOf(plan)) {
      const args = partArgs(plan, part, () => "/media/x.mp4", "p.mkv", { encoder: "libx264" });
      expect(args.filter((a) => a === "-i").length).toBeLessThanOrEqual(60);
    }
  });

  it("does not dip the sound where a part boundary falls inside continuous audio", () => {
    // 60 splits with no cuts: one take playing straight through, rendered as more than one part.
    const splits: Op[] = Array.from({ length: 60 }, (_, i) => ({ op: "clip.split" as const, clipId: "c1", atSourceUs: Math.round((0.09 * (60 - i)) * S) }));
    // Split from the end back, so the point is always inside clip c1, which keeps the start.
    const plan = compile(project([...base, ...splits]));
    const parts = partsOf(plan);
    expect(parts.length).toBeGreaterThan(1);
    const opts = { encoder: "libx264" as const };
    const first = partArgs(plan, parts[0]!, () => src, "a.mkv", opts).join(" ");
    const second = partArgs(plan, parts[1]!, () => src, "b.mkv", opts).join(" ");
    expect(first).not.toMatch(/afade=t=out/);
    expect(second).not.toMatch(/afade=t=in/);
  });

  it("keeps the filters running when a clip's colour tags change part way, and tags every part the same", () => {
    const seg = { trackKind: "main", tlStartUs: 0, tlEndUs: 10 * S, srcInUs: 0, srcOutUs: 10 * S, speed: 1, mediaId: "m", clipId: "c" };
    const plan = { fps: 30, width: 1920, height: 1080, durationUs: 10 * S, camera: [], overlays: [], segments: [seg] } as never;
    const args = partArgs(plan, partsOf(plan)[0]!, () => "/media/a.mp4", "/out/p.mkv", { encoder: "libx264" }, {}, null);
    expect(args.join(" ")).toContain("-reinit_filter 0 -ss");
    expect(args.join(" ")).toContain("-color_range tv");
  });

  it("gives a long clip a part of its own, so ffmpeg never waits on it behind another clip", () => {
    const seg = (start: number, len: number) => ({ trackKind: "main", tlStartUs: start * S, tlEndUs: (start + len) * S, srcInUs: 0, srcOutUs: len * S, speed: 1, mediaId: "m", clipId: `c${start}` });
    const plan = { fps: 30, durationUs: 679 * S, camera: [], overlays: [], segments: [seg(0, 37), seg(37, 592), seg(629, 20), seg(649, 30)] } as never;
    expect(partsOf(plan).map((p) => p.main.length)).toEqual([1, 1, 2]);
  });

  it("refuses an empty timeline and a second export of the same project", async () => {
    const ex = new Exporter();
    await expect(ex.start("p", compile(createProject()), () => src, path.join(dir, "e.mp4"), "libx264")).rejects.toThrow(/nothing/);
    const plan = compile(project(base));
    const job = await ex.start("p", plan, () => src, path.join(dir, "a.mp4"), "libx264");
    await expect(ex.start("p", plan, () => src, path.join(dir, "b.mp4"), "libx264")).rejects.toThrow(/already running/);
    expect(ex.cancel(job.id)).toBe(true);
    expect((await finish(ex, job)).state).toBe("cancelled");
    expect(existsSync(path.join(dir, "a.mp4"))).toBe(false);
  }, 60_000);

  it("renders a zoom that matches the camera at every sampled frame", async () => {
    // A still, detailed picture: any error in the camera shows up as a mismatch.
    const still = path.join(dir, "still.mp4");
    const png = path.join(dir, "still.png");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30", "-frames:v", "1", png]);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "30", "-t", "8", "-i", png, "-f", "lavfi", "-t", "8", "-i", "sine=f=440", "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", still]);
    let p = project([
      { op: "media.add", media: { id: "m1", path: "still.mp4", kind: "video", durationUs: 8 * S, probe: { hasVideo: true, hasAudio: true } } as never },
      { op: "clip.add", trackId: "main", mediaId: "m1", id: "c1" },
    ]);
    p = applyTransaction(p, { id: "tz", baseRevision: p.revision, by: "user", summary: "", ops: [{ op: "zoom.add", mediaId: "m1", startUs: 3 * S, endUs: 5 * S, rect: [0.5, 0.2, 0.3, 0.3] }] }, { newId: (x) => `${x}${++n}` }).project;
    const plan = compile(p);
    expect(plan.camera).toHaveLength(1);
    const pieces = videoPieces(plan, plan.segments[0]!);
    // Home, ease in, hold, ease out, home.
    expect(pieces.map((x) => Boolean(x.cam))).toEqual([false, true, true, true, false]);
    expect(pieces[0]!.tlEndUs).toBe(1.5 * S);

    const out = path.join(dir, "zoom.mp4");
    const ex = new Exporter();
    const job = await finish(ex, await ex.start("p", plan, () => still, out, "libx264"));
    expect(job.error).toBeUndefined();
    expect(Math.abs(probe(out).duration - 8)).toBeLessThan(0.06);

    // For sampled times, build the expected picture directly from the camera and compare.
    const ssim = (frame: number): number => {
      const c = cameraAt(plan, Math.round((frame / 30) * S));
      const w = 320 / c.scale;
      const h = 180 / c.scale;
      const x = c.cx * 320 - w / 2;
      const y = c.cy * 180 - h / 2;
      // Reference at 8x so a fractional crop lands on whole pixels.
      const ref = `[0:v]select='eq(n,${frame})'[o];[1:v]select='eq(n,0)',scale=2560:1440:flags=bicubic,crop=${Math.round(w * 8)}:${Math.round(h * 8)}:${Math.round(x * 8)}:${Math.round(y * 8)},scale=320:180:flags=bicubic[r];[o][r]ssim=stats_file=-`;
      // The frame is picked by number, so there is no doubt which one is read.
      const r = execFileSync("ffmpeg", ["-hide_banner", "-i", out, "-i", still, "-frames:v", "1", "-lavfi", ref, "-f", "null", "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return Number(/All:([\d.]+)/.exec(r)?.[1]);
    };
    // Before, easing in (including its fastest point), holding, easing out, after.
    const scores = [30, 54, 67, 68, 81, 105, 162, 180, 225].map((f) => [f, ssim(f)] as const);
    if (process.env.SOUS_DEBUG) console.log(scores.map(([f, v]) => `${f}:${v.toFixed(3)}`).join(" "));
    for (const [f, v] of scores) expect(v, `frame ${f}`).toBeGreaterThan(0.94);
    // And the check can fail: the zoomed frame must not look like the unzoomed picture.
    const plain = execFileSync("ffmpeg", ["-hide_banner", "-ss", "4", "-i", out, "-i", still, "-frames:v", "1", "-lavfi", "[0:v][1:v]ssim=stats_file=-", "-f", "null", "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    expect(Number(/All:([\d.]+)/.exec(plain)?.[1])).toBeLessThan(0.6);
  }, 120_000);

  it("renders empty space on the main track as black and silence, at full length", async () => {
    // Two 2 s clips with a 1.5 s hole between them and half a second before the first.
    const p = project([
      ...base,
      { op: "clip.trim", clipId: "c1", sourceOutUs: 2 * S },
      { op: "clip.move", clipId: "c1", startUs: 0.5 * S },
      { op: "clip.add", trackId: "main", mediaId: "m1", sourceInUs: 3 * S, sourceOutUs: 5 * S, startUs: 4 * S, id: "c2" },
    ]);
    const plan = compile(p);
    expect(plan.durationUs).toBe(6 * S);
    const ex = new Exporter();
    const out = path.join(dir, "gap.mp4");
    const job = await finish(ex, await ex.start("p", plan, () => src, out, "libx264"));
    expect(job.error).toBeUndefined();
    expect(probe(out).duration).toBeCloseTo(6, 1);
    // Brightness at 0.2 s (before the first clip), 1.5 s (in it) and 3.2 s (in the hole).
    const luma = (t: number) => {
      const raw = execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", out, "-frames:v", "1", "-vf", "scale=8:8,format=gray", "-f", "rawvideo", "pipe:1"]);
      return raw.reduce((a, b) => a + b, 0) / raw.length;
    };
    expect(luma(0.2)).toBeLessThan(25);
    expect(luma(1.5)).toBeGreaterThan(60);
    expect(luma(3.2)).toBeLessThan(25);
    expect(luma(5)).toBeGreaterThan(60);
  }, 60_000);

  it("draws a resized and cropped main clip where it is placed, over black", async () => {
    // Left half of the frame, with its top fifth cropped away.
    const p = project([...base, { op: "clip.trim", clipId: "c1", sourceOutUs: 2 * S }, { op: "clip.set", clipId: "c1", transform: { x: -0.25, y: 0, scale: 0.5, crop: [0, 0.2, 1, 0.8] } }]);
    const ex = new Exporter();
    const out = path.join(dir, "framed.mp4");
    const job = await finish(ex, await ex.start("p", compile(p), () => src, out, "libx264"));
    expect(job.error).toBeUndefined();
    expect(probe(out)).toMatchObject({ width: 320 });
    // Mean brightness of a region of the frame at 1 s.
    const raw = execFileSync("ffmpeg", ["-v", "error", "-ss", "1", "-i", out, "-frames:v", "1", "-vf", "format=gray", "-f", "rawvideo", "pipe:1"]);
    const region = (x0: number, y0: number, x1: number, y1: number) => {
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) (sum += raw[y * 320 + x]!), count++;
      return sum / count;
    };
    // The picture fills the left half from about 63 px down; the right half and the cropped top are black.
    expect(region(20, 80, 140, 130)).toBeGreaterThan(40);
    expect(region(180, 20, 300, 160)).toBeLessThan(20);
    expect(region(20, 50, 140, 58)).toBeLessThan(20);
  }, 60_000);
});
