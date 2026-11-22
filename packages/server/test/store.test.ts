import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { OpenProject } from "../src/store";
import { detectSilences } from "../src/transcribe";
import { execFileSync } from "node:child_process";

const root = mkdtempSync(path.join(os.tmpdir(), "sous-store-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("saving edits", () => {
  it("keeps memory in step with disk when a save fails, and a retry then applies", async () => {
    const dir = path.join(root, "a.sous");
    const p = await OpenProject.open(dir, true, () => {});
    // A folder where the history file should be makes the append fail.
    mkdirSync(path.join(dir, "history.jsonl"));
    const tx = { id: "tx-retry", baseRevision: 0, summary: "Add marker", ops: [{ op: "marker.add" as const, timeUs: 1_000_000 }] };
    await expect(p.apply(tx)).rejects.toThrow();
    expect(p.project.revision).toBe(0);
    expect(p.project.markers.length).toBe(0);
    rmSync(path.join(dir, "history.jsonl"), { recursive: true });
    const r = await p.apply(tx);
    expect(r.duplicate).toBe(false);
    expect(p.project.markers.length).toBe(1);
    const again = await OpenProject.open(dir, false, () => {});
    expect(again.project.markers.length).toBe(1);
  });
});

describe("project folders", () => {
  it("makes new projects as .sous and still opens projects from AI Garage Editor and Cutting Room", async () => {
    const made = await OpenProject.open(path.join(root, "new.sous"), true, () => {});
    expect(made.project.revision).toBe(0);
    for (const old of ["old.aigedit", "older.cutroom"]) {
      await OpenProject.open(path.join(root, old), true, () => {});
      const again = await OpenProject.open(path.join(root, old), false, () => {});
      expect(again.dir.endsWith(old)).toBe(true);
    }
    await expect(OpenProject.open(path.join(root, "plain-folder"), true, () => {})).rejects.toThrow(/\.sous/);
  });
});

describe("finding pauses", () => {
  it("finds every pause in a long file, not only the last ones", async () => {
    const wav = path.join(root, "pauses.wav");
    // Two minutes of half-second tone and half-second silence: 120 pauses.
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "aevalsrc=if(lt(mod(t\\,1)\\,0.5)\\,0.5*sin(2*PI*440*t)\\,0):s=16000:d=120", wav]);
    const found = await detectSilences(wav);
    expect(found.length).toBeGreaterThanOrEqual(118);
    expect(found[0]![0]).toBeLessThan(1_500_000);
  }, 60_000);
});
