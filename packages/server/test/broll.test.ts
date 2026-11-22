import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/http.js";
import { cleanStudioUrl } from "../src/broll.js";

const TOKEN = "test-token-broll-0123456789";
const KEY = "studio-test-key-abcdef";
let tmp = "";
let server: RunningServer;
let base = "";
let studio: http.Server;
let studioUrl = "";
let png: Buffer;
const before = process.env.SOUS_CHEF_HOME;
const seen: { kind?: string; params?: Record<string, unknown>; key?: string }[] = [];
const polls = new Map<string, number>();

async function local(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: (text.startsWith("{") ? JSON.parse(text) : text) as any };
}

async function until<T>(fn: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const ends = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > ends) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sous-broll-"));
  process.env.SOUS_CHEF_HOME = path.join(tmp, "home");
  mkdirSync(process.env.SOUS_CHEF_HOME, { recursive: true });
  const pic = path.join(tmp, "pic.png");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=orange:s=320x180", "-frames:v", "1", "-y", pic]);
  png = readFileSync(pic);
  // A stand-in Imagination Studio: takes a job, says it is halfway once, then done with one file.
  studio = http.createServer((req, res) => {
    const json = (code: number, v: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (req.headers["x-studio-key"] !== KEY) return json(401, { error: "key" });
    if (req.url === "/api/state") return json(200, { version: "test", platform_label: "Test box", image_models: [{ id: "a" }], turbo: false, presets: { p720: {} } });
    if (req.url === "/api/jobs" && req.method === "POST") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const b = JSON.parse(body);
        seen.push({ kind: b.kind, params: b.params, key: String(req.headers["x-studio-key"]) });
        json(200, { id: `job${seen.length}`, status: "queued" });
      });
      return;
    }
    const m = /^\/api\/jobs\/(job\d+)$/.exec(req.url ?? "");
    if (m) {
      const n = (polls.get(m[1]!) ?? 0) + 1;
      polls.set(m[1]!, n);
      return json(200, n < 2 ? { id: m[1], status: "running", progress: 0.5 } : { id: m[1], status: "done", outputs: [`scouts/${m[1]}/scout_s0.png`] });
    }
    if (req.url?.startsWith("/files/scouts/")) {
      res.writeHead(200, { "content-type": "image/png", "content-length": png.length });
      return res.end(png);
    }
    json(404, { error: "no" });
  });
  await new Promise<void>((r) => studio.listen(0, "127.0.0.1", () => r()));
  studioUrl = `http://127.0.0.1:${(studio.address() as AddressInfo).port}`;
  server = await startServer({ autoPrepare: false, token: TOKEN });
  base = `http://127.0.0.1:${server.port}`;
}, 30_000);

afterAll(async () => {
  await server?.close();
  await new Promise<void>((r) => studio.close(() => r()));
  if (before === undefined) delete process.env.SOUS_CHEF_HOME;
  else process.env.SOUS_CHEF_HOME = before;
  rmSync(tmp, { recursive: true, force: true });
});

describe("B-roll", () => {
  it("cleans the Studio's address and refuses a key sent in the clear to the internet", async () => {
    expect(cleanStudioUrl("127.0.0.1:7870/")).toBe("http://127.0.0.1:7870");
    expect(() => cleanStudioUrl("http://user:pw@x.example")).toThrow();
    const r = await local("POST", "/api/library/broll/settings", { studioUrl: "http://studio.example.com", key: "k" });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/https/);
  });

  it("keeps the key to itself and checks the Studio", async () => {
    const saved = await local("POST", "/api/library/broll/settings", { studioUrl, key: KEY });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ studioUrl, hasKey: true });
    expect(JSON.stringify((await local("GET", "/api/library/broll")).body)).not.toContain(KEY);
    const check = await local("POST", "/api/library/broll/check", {});
    expect(check.body.ok).toBe(true);
    expect(check.body.message).toMatch(/Test box/);
  });

  it("makes a picture locally at the Studio's defaults and keeps it in the library", async () => {
    const made = await local("POST", "/api/library/broll", { engine: "local", kind: "image", prompt: "a sunrise over a desk" });
    expect(made.status).toBe(200);
    expect(made.body.status).toBe("working");
    const done = await until(async () => {
      const it = (await local("GET", "/api/library/broll")).body.items.find((x: any) => x.id === made.body.id);
      return it.status === "working" ? undefined : it;
    });
    expect(done.status).toBe("done");
    expect(done.width).toBe(320);
    expect(existsSync(done.path)).toBe(true);
    expect(path.dirname(done.path)).toBe(path.join(process.env.SOUS_CHEF_HOME!, "library", "broll"));
    expect(seen[0]).toMatchObject({ kind: "scout", params: { prompt: "a sunrise over a desk", count: 1 }, key: KEY });
    const thumb = await fetch(`${base}/api/library/broll/${done.id}/thumb?token=${TOKEN}`);
    expect(thumb.headers.get("content-type")).toBe("image/png");
  });

  it("asks for a five-second 720p clip at the quick quality", async () => {
    await local("POST", "/api/library/broll", { engine: "local", kind: "video", prompt: "slow push in on a keyboard" });
    await until(async () => (seen.length >= 2 ? true : undefined));
    expect(seen[1]).toMatchObject({ kind: "video", params: { prompt: "slow push in on a keyboard", seconds: 5, preset: "p720", quality: "fh8" } });
    // The stand-in hands back a picture, so this one fails plainly rather than landing as a "video".
    const failed = await until(async () => (await local("GET", "/api/library/broll")).body.items.find((x: any) => x.kind === "video" && x.status === "failed"));
    expect(failed.error).toMatch(/video/i);
  });

  it("deletes one with its file", async () => {
    const items = (await local("GET", "/api/library/broll")).body.items;
    const done = items.find((x: any) => x.status === "done");
    expect((await local("POST", `/api/library/broll/${done.id}/delete`, {})).status).toBe(200);
    expect(existsSync(done.path)).toBe(false);
    expect((await local("GET", "/api/library/broll")).body.items.some((x: any) => x.id === done.id)).toBe(false);
  });

  it("refuses an empty prompt or an unknown engine", async () => {
    expect((await local("POST", "/api/library/broll", { engine: "local", kind: "image", prompt: " " })).status).toBe(400);
    expect((await local("POST", "/api/library/broll", { engine: "space", kind: "image", prompt: "x" })).status).toBe(400);
  });
});
