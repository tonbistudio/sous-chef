import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homeDir, migrateHome } from "../src/connect";

describe("moving over from AI Garage Editor", () => {
  const saved = { home: process.env.SOUS_CHEF_HOME, local: process.env.LOCALAPPDATA };
  let base = "";
  beforeEach(() => {
    base = mkdtempSync(path.join(os.tmpdir(), "sous-migrate-"));
    delete process.env.SOUS_CHEF_HOME;
    process.env.LOCALAPPDATA = base;
    const old = path.join(base, "ai-garage-editor");
    mkdirSync(path.join(old, "library", "templates"), { recursive: true });
    writeFileSync(path.join(old, "preferences.json"), '{"newProjectSpeed":1.1}');
    writeFileSync(path.join(old, "config.json"), '{"python":"x"}');
    writeFileSync(path.join(old, "library", "memory.md"), "- Works at 1.1x.");
    writeFileSync(path.join(old, "library", "templates", "intro.json"), "{}");
    writeFileSync(path.join(old, "server.json"), '{"port":1}');
    writeFileSync(path.join(old, "install.json"), "{}");
  });
  afterEach(() => {
    if (saved.home === undefined) delete process.env.SOUS_CHEF_HOME;
    else process.env.SOUS_CHEF_HOME = saved.home;
    process.env.LOCALAPPDATA = saved.local;
  });

  it("copies settings, the library and templates, but not the old server's connection files", async () => {
    // The app may have made the folder already, to start the server in.
    mkdirSync(homeDir(), { recursive: true });
    expect(await migrateHome()).toBe(true);
    const home = homeDir();
    expect(home).toBe(path.join(base, "sous-chef"));
    expect(readFileSync(path.join(home, "preferences.json"), "utf8")).toContain("1.1");
    expect(readFileSync(path.join(home, "library", "memory.md"), "utf8")).toContain("1.1x");
    expect(existsSync(path.join(home, "library", "templates", "intro.json"))).toBe(true);
    expect(existsSync(path.join(home, "config.json"))).toBe(true);
    expect(existsSync(path.join(home, "server.json"))).toBe(false);
    expect(existsSync(path.join(home, "install.json"))).toBe(false);
    // The old folder is left as it was.
    expect(existsSync(path.join(base, "ai-garage-editor", "server.json"))).toBe(true);
  });

  it("does it once: settings already here are never overwritten", async () => {
    mkdirSync(homeDir(), { recursive: true });
    writeFileSync(path.join(homeDir(), "preferences.json"), '{"newProjectSpeed":1}');
    expect(await migrateHome()).toBe(false);
    expect(readFileSync(path.join(homeDir(), "preferences.json"), "utf8")).toContain('"newProjectSpeed":1}');
  });
});
