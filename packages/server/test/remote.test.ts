import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRemote } from "../src/agentRemote.js";
import { startServer, type RunningServer } from "../src/http.js";
import { cleanPublicUrl, createKey, guardCall, matchKey, readRemote, revokeKey } from "../src/remote.js";

const TOKEN = "test-token-remote-0123456789";
let tmp = "";
let server: RunningServer;
let base = "";
const doorPort = 47_000 + Math.floor(Math.random() * 800);
const before = process.env.SOUS_CHEF_HOME;

async function local(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json()) as any };
}

async function connect(key: string) {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${doorPort}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  return client;
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sous-remote-"));
  process.env.SOUS_CHEF_HOME = path.join(tmp, "home");
  mkdirSync(process.env.SOUS_CHEF_HOME, { recursive: true });
  const projects = path.join(tmp, "projects");
  mkdirSync(projects);
  writeFileSync(path.join(process.env.SOUS_CHEF_HOME, "preferences.json"), JSON.stringify({ projectsFolder: projects }));
  writeFileSync(path.join(process.env.SOUS_CHEF_HOME, "remote.json"), JSON.stringify({ enabled: false, port: doorPort }));
  server = await startServer({ autoPrepare: false, token: TOKEN });
  base = `http://127.0.0.1:${server.port}`;
  const video = path.join(tmp, "take.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video]);
  // A project in the owner's projects folder, with the take on its main track.
  const opened = await local("POST", "/api/projects/open", { path: path.join(projects, "Demo.sous"), create: true });
  const pid = opened.body.projectId as string;
  const proj = await local("GET", `/api/p/${pid}/project`);
  const added = await local("POST", `/api/p/${pid}/transactions`, { baseRevision: proj.body.project.revision, by: "user", summary: "add", ops: [{ op: "media.add", media: { path: video, id: "m1" } }, { op: "clip.add", trackId: "main", mediaId: "m1", id: "c1" }] });
  if (added.status !== 200) throw new Error(JSON.stringify(added.body));
});

afterAll(async () => {
  await server.close();
  if (before === undefined) delete process.env.SOUS_CHEF_HOME;
  else process.env.SOUS_CHEF_HOME = before;
  rmSync(tmp, { recursive: true, force: true });
});

describe("agent keys", () => {
  it("shows a key once, keeps only its fingerprint, and forgets it when revoked", async () => {
    const { key, record } = await createKey("vps");
    expect(key).toMatch(/^sck_/);
    expect(readFileSync(path.join(process.env.SOUS_CHEF_HOME!, "remote.json"), "utf8")).not.toContain(key);
    const keys = (await readRemote()).keys;
    expect(matchKey(keys, key)?.name).toBe("vps");
    expect(matchKey(keys, key + "x")).toBeNull();
    expect(matchKey(keys, null)).toBeNull();
    await revokeKey(record.id);
    expect(matchKey((await readRemote()).keys, key)).toBeNull();
  });

  it("tidies the public address the owner types", () => {
    expect(cleanPublicUrl("sous.example.com/")).toBe("https://sous.example.com");
    expect(cleanPublicUrl("https://sous.example.com/mcp")).toBe("https://sous.example.com");
    expect(cleanPublicUrl("")).toBe("");
  });
});

describe("what remote agents may do", () => {
  const folder = path.join(os.tmpdir(), "owner-projects");
  it("opens only the owner's projects and labels edits with the agent", async () => {
    await expect(guardCall("project", { action: "open", path: "C:/Windows/x.sous" }, "vps", folder)).rejects.toThrow(/projects folder/);
    await expect(guardCall("project", { action: "open", path: path.join(folder, "A.sous") }, "vps", folder)).resolves.toBeTruthy();
    expect((await guardCall("edit_apply", { summary: "Cut the pause", ops: [] }, "vps", folder)).summary).toBe("vps: Cut the pause");
  });
  it("refuses anything that reaches files on disk", async () => {
    await expect(guardCall("edit_apply", { ops: [{ op: "media.add", media: { path: "C:/secret.mp4" } }] }, "vps", folder)).rejects.toThrow(/Importing/);
    await expect(guardCall("library", { action: "reference_add", path: "C:/x.mp4" }, "vps", folder)).rejects.toThrow();
    await expect(guardCall("publish", { action: "add_thumbnail", path: "C:/x.png" }, "vps", folder)).rejects.toThrow();
    await expect(guardCall("publish", { action: "settings_set", thumbnail_refs: ["C:/x.png"] }, "vps", folder)).rejects.toThrow();
    await expect(guardCall("render", { action: "start", path: "C:/out.mp4" }, "vps", folder)).rejects.toThrow(/exports folder/);
  });
});

describe("the remote door", () => {
  it("is closed until turned on, then lets a keyed agent use the tools", async () => {
    await expect(fetch(`http://127.0.0.1:${doorPort}/health`)).rejects.toThrow();
    const on = await local("POST", "/api/remote", { enabled: true, publicUrl: "sous.example.com" });
    expect(on.body.status).toMatchObject({ running: true, port: doorPort });
    expect(on.body.publicUrl).toBe("https://sous.example.com");

    // No key, a wrong key: refused.
    expect((await fetch(`http://127.0.0.1:${doorPort}/mcp`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${doorPort}/mcp`, { method: "POST", headers: { authorization: "Bearer sck_nope" }, body: "{}" })).status).toBe(401);
    // The editor's own token doesn't open the door either.
    expect((await fetch(`http://127.0.0.1:${doorPort}/mcp`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{}" })).status).toBe(401);

    const made = await local("POST", "/api/remote/keys", { name: "spark" });
    const client = await connect(made.body.key);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["project", "edit_apply", "frame_get", "media_clip"]));

    const listed = JSON.parse((await client.callTool({ name: "project", arguments: { action: "list" } })).content[0].text);
    expect(listed.projects.map((p: { name: string }) => p.name)).toEqual(["Demo"]);
    const pid = listed.open[0].projectId;

    const refused = await client.callTool({ name: "edit_apply", arguments: { project_id: pid, base_revision: 1, summary: "x", ops: [{ op: "media.add", media: { path: "C:/x.mp4" } }] } });
    expect(refused.isError).toBe(true);

    // An edit goes through and is labelled with the agent.
    const proj = JSON.parse((await client.callTool({ name: "project", arguments: { action: "get", project_id: pid } })).content[0].text);
    const done = await client.callTool({ name: "edit_apply", arguments: { project_id: pid, base_revision: proj.revision, summary: "Add a marker", ops: [{ op: "marker.add", timeUs: 1_000_000, label: "Intro" }] } });
    expect(done.isError).toBeFalsy();
    const history = await local("GET", `/api/p/${pid}/project`);
    expect(JSON.stringify(history.body.history)).toContain("spark: Add a marker");

    // A clip to listen to, through a link on the door.
    const clip = JSON.parse((await client.callTool({ name: "media_clip", arguments: { project_id: pid, timeline_us: 0, duration_us: 2_000_000, kind: "audio" } })).content[0].text);
    // Links use the public address the owner gave, so the agent's computer can open them.
    expect(clip.url).toMatch(/^https:\/\/sous\.example\.com\/clips\/.+\.mp3$/);
    const got = await fetch(clip.url.replace("https://sous.example.com", `http://127.0.0.1:${doorPort}`));
    expect(got.status).toBe(200);
    expect((await got.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    await client.close();

    // Revoked: the next call is refused at once.
    await local("POST", `/api/remote/keys/${made.body.id}/delete`, {});
    expect((await fetch(`http://127.0.0.1:${doorPort}/mcp`, { method: "POST", headers: { authorization: `Bearer ${made.body.key}` }, body: "{}" })).status).toBe(401);

    const off = await local("POST", "/api/remote", { enabled: false });
    expect(off.body.status.running).toBe(false);
    await expect(fetch(`http://127.0.0.1:${doorPort}/health`)).rejects.toThrow();
  }, 60_000);
});

describe("chat with Hermes on another computer", () => {
  /** A stand-in for Hermes's API server: one run that writes, uses a tool and finishes. */
  async function fakeHermes(script: (runBody: any) => string[]): Promise<{ url: string; bodies: any[]; close(): Promise<void> }> {
    const bodies: any[] = [];
    const srv = http.createServer((req, res) => {
      if (req.headers.authorization !== "Bearer api-key") return void res.writeHead(401).end("{}");
      if (req.method === "POST" && req.url === "/v1/runs") {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => {
          bodies.push(JSON.parse(b));
          res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ run_id: "run_1", status: "started" }));
        });
        return;
      }
      if (req.url === "/v1/runs/run_1/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": keepalive\n\n");
        for (const ev of script(bodies.at(-1))) res.write(`data: ${ev}\n\n`);
        res.end();
        return;
      }
      res.writeHead(404).end("{}");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, bodies, close: () => new Promise((r) => srv.close(() => r())) };
  }

  it("streams the answer, reports tools, and keeps one session across messages", async () => {
    const h = await fakeHermes(() => [
      JSON.stringify({ event: "message.delta", delta: "Cutting " }),
      JSON.stringify({ event: "tool.started", tool: "mcp_sous_chef_edit_apply" }),
      JSON.stringify({ event: "message.delta", delta: "the pause." }),
      JSON.stringify({ event: "run.completed", output: "Cut the pause at 0:12." }),
    ]);
    const seen: string[] = [];
    const tools: string[] = [];
    const first = await runRemote({ url: h.url, key: "api-key" }, { text: "cut it", images: ["data:image/png;base64,AAAA"] }, { onText: (t) => seen.push(t), onTool: (n) => tools.push(n) });
    expect(first.text).toBe("Cut the pause at 0:12.");
    expect(seen.at(-1)).toBe("Cutting the pause.");
    expect(tools).toEqual(["mcp_sous_chef_edit_apply"]);
    expect(h.bodies[0].input[0].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
    const second = await runRemote({ url: h.url, key: "api-key" }, { text: "again", sessionId: first.sessionId });
    expect(second.sessionId).toBe(first.sessionId);
    expect(h.bodies[1]).toMatchObject({ input: "again", session_id: first.sessionId });
    await h.close();
  });

  it("explains a wrong key and a failed run in plain words", async () => {
    const h = await fakeHermes(() => [JSON.stringify({ event: "run.failed", error: "Model is overloaded" })]);
    await expect(runRemote({ url: h.url, key: "wrong" }, { text: "hi" })).rejects.toThrow(/refused the key/);
    await expect(runRemote({ url: h.url, key: "api-key" }, { text: "hi" })).rejects.toThrow(/overloaded/);
    await h.close();
  });
});
