import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { addThumbRef, readPublish, refsDir, removeThumbRef, writePublish } from "../src/publish.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "sous-brief-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");

describe("thumbnail brief", () => {
  it("keeps instructions and reference pictures, each marked theme or include", async () => {
    const a = await addThumbRef(dir, PNG, "png");
    const b = await addThumbRef(dir, PNG, "jpg");
    expect(existsSync(path.join(refsDir(dir), a.file))).toBe(true);
    expect(b.data.thumbRefs.map((r) => r.use)).toEqual(["theme", "theme"]);

    const d = await writePublish(dir, { thumbInstructions: "Logo big on the right", thumbRefs: [{ file: b.file, use: "include" }, { file: "nope.png", use: "include" }] });
    expect(d.thumbInstructions).toBe("Logo big on the right");
    // Order follows the patch, unknown pictures are ignored, and none are lost.
    expect(d.thumbRefs).toEqual([{ file: b.file, use: "include" }, { file: a.file, use: "theme" }]);

    const e = await removeThumbRef(dir, a.file);
    expect(e.thumbRefs).toEqual([{ file: b.file, use: "include" }]);
    expect((await readPublish(dir)).thumbInstructions).toBe("Logo big on the right");
  });

  it("refuses odd files and names", async () => {
    await expect(addThumbRef(dir, PNG, "gif")).rejects.toThrow();
    await expect(addThumbRef(dir, Buffer.alloc(0), "png")).rejects.toThrow(/empty/);
    await expect(removeThumbRef(dir, "../publish.json")).rejects.toThrow();
  });
});
