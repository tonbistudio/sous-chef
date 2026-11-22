import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addReference, listReferences, referenceFrame, referencesBriefing, referenceThumb, removeReference, updateReference } from "../src/references.js";

let dir = "";
let video = "";
const before = process.env.SOUS_CHEF_HOME;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "sous-refs-"));
  process.env.SOUS_CHEF_HOME = path.join(dir, "home");
  video = path.join(dir, "Ref Clip.mp4");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=180x320:r=30:d=4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", video]);
});

afterAll(() => {
  if (before === undefined) delete process.env.SOUS_CHEF_HOME;
  else process.env.SOUS_CHEF_HOME = before;
  rmSync(dir, { recursive: true, force: true });
});

describe("reference videos", () => {
  it("keeps a video by path, with its size, a thumbnail and frames, and never touches the file", async () => {
    const mtime = statSync(video).mtimeMs;
    const ref = await addReference(video, "the intro");
    expect(ref).toMatchObject({ name: "Ref Clip", note: "the intro", width: 180, height: 320 });
    expect(ref.durationUs).toBeGreaterThan(3_900_000);
    // The same path again (any case) is the same reference.
    const again = await addReference(video.toUpperCase(), "pacing");
    expect(again.id).toBe(ref.id);
    expect((await listReferences()).map((r) => [r.note, r.missing])).toEqual([["pacing", false]]);

    const thumb = await referenceThumb(ref.id);
    expect(thumb.subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(existsSync(path.join(process.env.SOUS_CHEF_HOME!, "library", "reference-thumbs", `${ref.id}.jpg`))).toBe(true);
    expect((await referenceFrame(ref.id, 2_000_000, 320)).subarray(0, 2).toString("hex")).toBe("ffd8");

    await updateReference(ref.id, { name: "Intro style" });
    expect(await referencesBriefing()).toContain(`${ref.id}: "Intro style" (4 s, 180x320) — pacing`);
    expect(await referencesBriefing()).toMatch(/never change, move or delete/);

    await removeReference(ref.id);
    expect(await listReferences()).toEqual([]);
    expect(existsSync(video)).toBe(true);
    expect(statSync(video).mtimeMs).toBe(mtime);
  });

  it("says what is wrong with a bad path", async () => {
    await expect(addReference("relative.mp4")).rejects.toThrow(/full path/);
    await expect(addReference(path.join(dir, "nope.mp4"))).rejects.toThrow(/No file/);
  });
});
