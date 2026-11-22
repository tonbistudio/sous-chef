import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "../src/http.js";

const TOKEN = "test-token-0123456789";
let tmp: string;
let video: string;
let server: RunningServer;
let base: string;

async function api(method: string, url: string, body?: unknown, token: string | null = TOKEN) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sous-test-"));
  // Never read or write the real app home (preferences, library) from a test.
  process.env.SOUS_CHEF_HOME = path.join(tmp, "home");
  video = path.join(tmp, "take one.mp4");
  // A 4-second 320x180 test clip with a tone, so probing, ranges and frames run against a real file.
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video,
  ]);
  server = await startServer({ autoPrepare: false, token: TOKEN });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("edit server", () => {
  let pid: string;
  const dir = () => path.join(tmp, "demo.sous");

  it("answers health without a token and refuses everything else", async () => {
    expect((await api("GET", "/api/health", undefined, null)).body).toMatchObject({ ok: true, name: "sous-chef" });
    expect((await api("GET", "/api/projects", undefined, null)).status).toBe(401);
    expect((await api("GET", "/api/projects", undefined, "wrong")).status).toBe(401);
  });

  it("refuses a request addressed to another host name", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: server.port, path: "/api/health", headers: { host: "evil.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("keeps the server alive on the project picker before any project is open", async () => {
    expect((await api("GET", "/api/projects")).body.projects).toEqual([]);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${TOKEN}`);
    try {
      const hello = await new Promise<unknown>((resolve, reject) => {
        ws.once("message", (data) => resolve(JSON.parse(String(data))));
        ws.once("error", reject);
      });
      expect(hello).toMatchObject({ type: "hello", projects: [] });
      // Simulate time passing without polling the server or opening a project.
      const now = Date.now;
      const later = now() + 11 * 60_000;
      try {
        Date.now = () => later;
        expect(server.idleMs()).toBe(0);
      } finally {
        Date.now = now;
      }
      const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
      ws.close();
      await closed;
      // The server receives its close event independently of the client.
      await expect.poll(() => {
        try {
          Date.now = () => now() + 11 * 60_000;
          return server.idleMs();
        } finally {
          Date.now = now;
        }
      }).toBeGreaterThan(10 * 60_000);
    } finally {
      ws.terminate();
    }
  });

  it("makes an empty project by name, with no video, that can hold text and keep a publish draft", async () => {
    const folder = path.join(tmp, "projects");
    const made = await api("POST", "/api/projects/new", { name: "My: demo?", folder });
    expect(made.status).toBe(200);
    expect(made.body.path.replace(/\\/g, "/")).toBe(path.join(folder, "My demo.sous").replace(/\\/g, "/"));
    expect((await api("POST", "/api/projects/new", { name: "My demo", folder })).status).toBe(409);
    expect((await api("GET", "/api/preferences")).body.projectsFolder).toBe(folder.replace(/\\/g, "/"));
    const pid = made.body.projectId;
    // Text alone gives the timeline a length.
    const tx = await api("POST", `/api/p/${pid}/transactions`, { baseRevision: 0, ops: [{ op: "overlay.add", kind: "text", startUs: 0, durationUs: 3_000_000, text: "Title card" }] });
    expect(tx.status).toBe(200);
    expect((await api("GET", `/api/p/${pid}/plan`)).body.durationUs).toBe(3_000_000);

    // Title, description and a thumbnail option, kept in the project folder.
    const saved = await api("POST", `/api/p/${pid}/publish`, { title: "First line\nsecond", titles: ["A", " ", "B"], description: "Hello" });
    expect(saved.body).toMatchObject({ title: "First line second", titles: ["A", "B"], description: "Hello" });
    const pic = path.join(tmp, "thumb.png");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=red:s=320x180", "-frames:v", "1", pic]);
    const added = await api("POST", `/api/p/${pid}/publish/thumbnails`, { path: pic, note: "red", by: "agent" });
    expect(added.status).toBe(200);
    expect(added.body.chosen).toBe(added.body.file);
    expect(readFileSync(added.body.path).length).toBeGreaterThan(0);
    expect((await api("POST", `/api/p/${pid}/publish/thumbnails`, { path: path.join(tmp, "x.txt") })).status).toBe(400);
    const brief = (await api("GET", `/api/p/${pid}/publish/brief`)).body;
    expect(brief).toMatchObject({ finishedLength: "0:03", current: { title: "First line second" } });
    expect(brief.current.thumbnails[0].note).toBe("red");
    const removed = await api("POST", `/api/p/${pid}/publish/thumbnails/${encodeURIComponent(added.body.file)}/delete`, {});
    expect(removed.body.thumbnails).toEqual([]);
    // Shared templates: a format file is read fresh.
    const fmt = path.join(tmp, "desc.txt");
    writeFileSync(fmt, "HOOK then LINKS");
    await api("POST", "/api/library/publish", { descriptionTemplateFile: fmt, channelName: "Chan" });
    writeFileSync(fmt, "HOOK then LINKS then CHAPTERS");
    expect((await api("GET", `/api/p/${pid}/publish/brief`)).body).toMatchObject({ descriptionTemplate: "HOOK then LINKS then CHAPTERS", channelName: "Chan" });
  });

  it("creates a project, imports a real file by path and builds a plan", async () => {
    expect((await api("POST", "/api/projects/open", { path: path.join(tmp, "nope.sous") })).status).toBe(404);
    expect((await api("POST", "/api/projects/open", { path: path.join(tmp, "bad-name"), create: true })).status).toBe(400);
    const opened = await api("POST", "/api/projects/open", { path: dir(), create: true });
    expect(opened.status).toBe(200);
    pid = opened.body.projectId;

    const added = await api("POST", `/api/p/${pid}/transactions`, {
      baseRevision: 0, by: "user", summary: "Import take",
      ops: [{ op: "media.add", media: { path: video, id: "m1" } }, { op: "clip.add", trackId: "main", mediaId: "m1", id: "c1" }],
    });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ revision: 1, created: ["m1", "c1"], duplicate: false });

    const got = await api("GET", `/api/p/${pid}/project`);
    const media = got.body.project.media[0];
    expect(media).toMatchObject({ id: "m1", kind: "video", probe: { hasVideo: true, hasAudio: true, width: 320, height: 180, fps: 30 } });
    expect(Math.abs(media.durationUs - 4_000_000)).toBeLessThan(150_000);
    // The file is outside the project folder, so its absolute path is kept.
    expect(media.path).toBe(video.replace(/\\/g, "/"));

    const plan = await api("GET", `/api/p/${pid}/plan`);
    expect(plan.body.segments).toHaveLength(1);
    expect(plan.body.durationUs).toBe(media.durationUs);
  });

  it("rejects stale and invalid edits with clear errors and changes nothing", async () => {
    const stale = await api("POST", `/api/p/${pid}/transactions`, { baseRevision: 0, ops: [{ op: "clip.remove", clipId: "c1" }] });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: "stale_revision", details: { currentRevision: 1 } });
    const bad = await api("POST", `/api/p/${pid}/transactions`, { baseRevision: 1, ops: [{ op: "clip.remove", clipId: "ghost" }] });
    expect(bad.status).toBe(404);
    const missing = await api("POST", `/api/p/${pid}/transactions`, { baseRevision: 1, ops: [{ op: "media.add", media: { path: path.join(tmp, "missing.mp4") } }] });
    expect(missing.status).toBe(404);
    expect((await api("GET", `/api/p/${pid}/project`)).body.project.revision).toBe(1);
  });

  it("broadcasts changes, and undo and redo work", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${TOKEN}`);
    const events: any[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("message", (data) => {
        const e = JSON.parse(String(data));
        events.push(e);
        if (e.type === "hello") resolve();
      });
      ws.on("error", reject);
    });

    const cut = await api("POST", `/api/p/${pid}/transactions`, {
      id: "tx-cut", baseRevision: 1, by: "agent", summary: "Cut one second",
      ops: [{ op: "range.remove", clipId: "c1", startUs: 1_000_000, endUs: 2_000_000 }],
    });
    expect(cut.body.revision).toBe(2);
    const again = await api("POST", `/api/p/${pid}/transactions`, {
      id: "tx-cut", baseRevision: 1, by: "agent", summary: "Cut one second",
      ops: [{ op: "range.remove", clipId: "c1", startUs: 1_000_000, endUs: 2_000_000 }],
    });
    expect(again.body).toMatchObject({ revision: 2, duplicate: true });

    const planCut = (await api("GET", `/api/p/${pid}/plan`)).body;
    expect(planCut.segments).toHaveLength(2);
    expect(planCut.segments[1]).toMatchObject({ srcInUs: 2_000_000, tlStartUs: 1_000_000, afterCut: true });

    expect((await api("POST", `/api/p/${pid}/undo`)).body).toMatchObject({ revision: 3, txId: "tx-cut" });
    expect((await api("GET", `/api/p/${pid}/plan`)).body.segments).toHaveLength(1);
    expect((await api("POST", `/api/p/${pid}/redo`)).body.revision).toBe(4);
    expect((await api("POST", `/api/p/${pid}/redo`)).status).toBe(400);

    await new Promise((r) => setTimeout(r, 100));
    ws.close();
    const changes = events.filter((e) => e.type === "change");
    expect(changes.map((e) => [e.kind, e.revision, e.by])).toEqual([["apply", 2, "agent"], ["undo", 3, "agent"], ["redo", 4, "agent"]]);
    expect(changes[0]).toMatchObject({ projectId: pid, summary: "Cut one second", txId: "tx-cut" });
  });

  it("refuses a WebSocket without the token", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=nope`);
    const outcome = await new Promise<string>((resolve) => {
      ws.on("open", () => resolve("open"));
      ws.on("error", () => resolve("refused"));
    });
    expect(outcome).toBe("refused");
  });

  it("serves media with byte ranges that match the file", async () => {
    const file = readFileSync(video);
    const url = `${base}/api/p/${pid}/media/m1?token=${TOKEN}`;

    const head = await fetch(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("accept-ranges")).toBe("bytes");
    expect(Number(head.headers.get("content-length"))).toBe(file.length);
    expect(head.headers.get("content-type")).toBe("video/mp4");

    const mid = await fetch(url, { headers: { range: "bytes=100-299" } });
    expect(mid.status).toBe(206);
    expect(mid.headers.get("content-range")).toBe(`bytes 100-299/${file.length}`);
    expect(Buffer.from(await mid.arrayBuffer()).equals(file.subarray(100, 300))).toBe(true);

    const tail = await fetch(url, { headers: { range: "bytes=-50" } });
    expect(Buffer.from(await tail.arrayBuffer()).equals(file.subarray(file.length - 50))).toBe(true);

    const open = await fetch(url, { headers: { range: `bytes=${file.length - 10}-` } });
    expect(open.headers.get("content-range")).toBe(`bytes ${file.length - 10}-${file.length - 1}/${file.length}`);

    expect((await fetch(url, { headers: { range: `bytes=${file.length + 5}-` } })).status).toBe(416);
    expect((await fetch(`${base}/api/p/${pid}/media/m1`)).status).toBe(401);
    expect((await fetch(`${base}/api/p/${pid}/media/zzz?token=${TOKEN}`)).status).toBe(404);
  });

  it("returns a real JPEG frame by source time and by timeline time", async () => {
    const bySource = await fetch(`${base}/api/p/${pid}/frame?mediaId=m1&us=500000&width=160&token=${TOKEN}`);
    expect(bySource.status).toBe(200);
    const jpeg = Buffer.from(await bySource.arrayBuffer());
    expect(jpeg.subarray(0, 3).toString("hex")).toBe("ffd8ff");
    expect(jpeg.length).toBeGreaterThan(500);

    // Timeline 1.5 s is after the cut (1 s to 2 s removed), so it must come from source 2.5 s.
    const byTimeline = await fetch(`${base}/api/p/${pid}/frame?tlUs=1500000&width=160&token=${TOKEN}`);
    expect(byTimeline.headers.get("x-source-us")).toBe("2500000");
    expect((await fetch(`${base}/api/p/${pid}/frame?tlUs=99000000&token=${TOKEN}`)).status).toBe(404);
  });

  it("keeps state and undo history across a restart, and repairs a project that is behind its history", async () => {
    const before = (await api("GET", `/api/p/${pid}/project`)).body.project;
    const projectFile = path.join(dir(), "project.json");
    const savedText = readFileSync(projectFile, "utf8");
    expect(JSON.parse(savedText)).toEqual(before);

    // Simulate a crash after history was written but before project.json was: roll project.json back one step.
    await api("POST", `/api/p/${pid}/transactions`, { baseRevision: before.revision, summary: "Marker", ops: [{ op: "marker.add", timeUs: 1, id: "k1" }] });
    writeFileSync(projectFile, savedText);

    const second = await startServer({ autoPrepare: false, token: TOKEN });
    try {
      const b2 = `http://127.0.0.1:${second.port}`;
      const call = async (method: string, url: string, body?: unknown) => {
        const res = await fetch(b2 + url, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
        return res.json() as Promise<any>;
      };
      const opened = await call("POST", "/api/projects/open", { path: dir() });
      expect(opened.projectId).toBe(pid);
      expect(opened.revision).toBe(before.revision + 1);
      const reopened = await call("GET", `/api/p/${pid}/project`);
      expect(reopened.project.markers).toEqual([{ id: "k1", timeUs: 1, label: "" }]);
      expect(reopened.history).toMatchObject({ canUndo: true, undo: "Marker" });
      expect(JSON.parse(readFileSync(projectFile, "utf8")).revision).toBe(before.revision + 1);
      const undone = await call("POST", `/api/p/${pid}/undo`);
      expect(undone.summary).toBe("Marker");
      expect((await call("GET", `/api/p/${pid}/project`)).project.markers).toEqual([]);
    } finally {
      await second.close();
    }
  });

  it("lets the sandboxed Hermes frame in, and no other site", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    // A sandboxed frame has the literal origin "null" and asks permission before sending the token.
    const preflight = await fetch(`${base}/api/projects`, {
      method: "OPTIONS",
      headers: { origin: "null", "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("null");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");

    // Being allowed to ask is not access: the token is still required.
    const noToken = await fetch(`${base}/api/projects`, { headers: { origin: "null" } });
    expect(noToken.status).toBe(401);
    expect(noToken.headers.get("access-control-allow-origin")).toBe("null");

    const other = await fetch(`${base}/api/projects`, { headers: { origin: "https://example.com", authorization: `Bearer ${server.token}` } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});
