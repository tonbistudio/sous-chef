import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callTool, TOOLS, type EditApi, type ToolResult } from "./agentTools.js";
import { homeDir } from "./connect.js";
import { readPreferences } from "./library.js";

/**
 * Remote agents: a second, separate door into the editor for agents on other computers (a VPS,
 * a DGX Spark, a cloud Hermes). The owner points a tunnel at it. Only the editing tools come
 * through it, as a standard MCP endpoint at /mcp, and only for a named key the owner made in
 * Settings and can revoke. Anything that would touch files outside the owner's projects is refused.
 */

export const DEFAULT_REMOTE_PORT = 47900;

export interface AgentKey {
  id: string;
  name: string;
  /** sha256 of the key; the key itself is shown once and never stored. */
  hash: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Hermes on another computer that the chat panel talks to instead of the local one. */
export interface ChatAgent {
  url: string;
  key: string;
}

export interface RemoteState {
  enabled: boolean;
  port: number;
  /** The tunnel's public address, only used to fill in the setup instructions. */
  publicUrl: string;
  keys: AgentKey[];
  chatAgent: ChatAgent | null;
}

const file = () => path.join(homeDir(), "remote.json");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export async function readRemote(): Promise<RemoteState> {
  const base: RemoteState = { enabled: false, port: DEFAULT_REMOTE_PORT, publicUrl: "", keys: [], chatAgent: null };
  try {
    const saved = JSON.parse(await readFile(file(), "utf8")) as Partial<RemoteState>;
    return {
      enabled: saved.enabled === true,
      port: Number.isInteger(saved.port) && saved.port! > 1023 && saved.port! < 65536 ? saved.port! : DEFAULT_REMOTE_PORT,
      publicUrl: typeof saved.publicUrl === "string" ? saved.publicUrl : "",
      keys: Array.isArray(saved.keys) ? saved.keys.filter((k) => k && typeof k.hash === "string" && typeof k.id === "string") : [],
      chatAgent: saved.chatAgent && typeof saved.chatAgent.url === "string" && typeof saved.chatAgent.key === "string" ? saved.chatAgent : null,
    };
  } catch {
    return base;
  }
}

let writing: Promise<unknown> = Promise.resolve();
/** Changes are made one at a time, so two quick edits never undo each other. */
export function updateRemote(change: (s: RemoteState) => void): Promise<RemoteState> {
  const next = writing.then(async () => {
    const s = await readRemote();
    change(s);
    await mkdir(homeDir(), { recursive: true });
    await writeFile(file(), JSON.stringify(s, null, 1), { encoding: "utf8", mode: 0o600 });
    return s;
  });
  writing = next.catch(() => undefined);
  return next;
}

/** Normalises what the owner typed as the public address: https:// added, trailing slash and /mcp dropped. */
export function cleanPublicUrl(raw: string): string {
  let u = raw.trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  const parsed = new URL(u);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "").replace(/\/mcp$/, "")}`;
}

export async function createKey(name: string): Promise<{ key: string; record: AgentKey }> {
  const clean = name.replace(/[^\w .-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || "agent";
  const key = `sck_${randomBytes(24).toString("base64url")}`;
  const record: AgentKey = { id: randomBytes(6).toString("hex"), name: clean, hash: sha(key), createdAt: new Date().toISOString(), lastUsedAt: null };
  await updateRemote((s) => {
    if (s.keys.some((k) => k.name.toLowerCase() === clean.toLowerCase())) record.name = `${clean} ${s.keys.length + 1}`;
    s.keys.push(record);
  });
  return { key, record };
}

export async function revokeKey(id: string): Promise<void> {
  await updateRemote((s) => {
    s.keys = s.keys.filter((k) => k.id !== id);
  });
}

/** The key record a bearer token belongs to, compared in constant time. */
export function matchKey(keys: AgentKey[], given: string | null): AgentKey | null {
  if (!given) return null;
  const h = Buffer.from(sha(given), "hex");
  let found: AgentKey | null = null;
  for (const k of keys) {
    const b = Buffer.from(k.hash, "hex");
    if (b.length === h.length && timingSafeEqual(b, h)) found = k;
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// What remote agents may do

const REMOTE_NOTE =
  "You are connected to the owner's Sous Chef from another computer: you can't open their files directly, so look at video with frame_get, reference_frames and media_clip, and read speech with transcript.";

/** The tool list remote agents see: the same tools, local-only hints swapped out, plus media_clip. */
export function remoteTools() {
  const tools = TOOLS.map((t) => ({
    ...t,
    description: t.description
      .replace(/they are local files you may also read directly with your own tools \(ffmpeg, transcription\), read-only; /, "")
      .replace(/reference_add adds one by full path with a note on what it's a reference for; /, "")
      .replace(/open one by folder path, /, "open one of the owner's projects by the path that list gives, "),
  }));
  return [
    ...tools,
    {
      name: "media_clip",
      description: `Sous Chef: a short piece of the video to download and watch or listen to with your own tools. ${REMOTE_NOTE} Give timeline_us (a point in the edit) or media_id with source_us, duration_us (at most 60 s) and kind: 'audio' (mp3) or 'video' (small mp4, 640 wide, with sound). Returns a download link that works for 15 minutes. All times are whole microseconds (1 second = 1000000).`,
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          timeline_us: { type: "integer" },
          media_id: { type: "string" },
          source_us: { type: "integer" },
          duration_us: { type: "integer", description: "Default 15 s, at most 60 s." },
          kind: { type: "string", enum: ["audio", "video"] },
        },
        required: ["project_id"],
      },
    },
  ];
}

class Refused extends Error {}

const inside = (dir: string, p: string) => {
  const a = path.resolve(dir).toLowerCase();
  const b = path.resolve(p).toLowerCase();
  return b === a || b.startsWith(a + path.sep);
};

/** The owner's projects: every .sous folder in the projects folder (one level down too). */
export async function ownerProjects(folder: string): Promise<{ name: string; path: string }[]> {
  const out: { name: string; path: string }[] = [];
  const look = async (dir: string, depth: number) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (/\.(sous|aigedit|cutroom)$/i.test(e.name)) out.push({ name: e.name.replace(/\.(sous|aigedit|cutroom)$/i, ""), path: full.replace(/\\/g, "/") });
      else if (depth > 0 && !e.name.startsWith(".")) await look(full, depth - 1);
    }
  };
  await look(folder, 1);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Checks a remote agent's call before it runs. Throws Refused for anything that would reach
 * outside the owner's projects; returns the arguments to use (edits get the agent's name).
 */
export async function guardCall(name: string, args: Record<string, unknown>, agent: string, projectsFolder: string): Promise<Record<string, unknown>> {
  const refuse = (why: string): never => {
    throw new Refused(`${why} Agents on other computers can't do this; ask the owner to do it in Sous Chef.`);
  };
  const a = { ...args };
  if (name === "project" && a.action === "open") {
    if (typeof a.path !== "string" || !inside(projectsFolder, a.path)) refuse("Only projects in the owner's projects folder can be opened (project list shows them).");
  }
  if (name === "edit_apply") {
    if (Array.isArray(a.ops) && a.ops.some((o) => (o as { op?: unknown })?.op === "media.add")) refuse("Importing files from disk isn't available.");
    a.summary = `${agent}: ${String(a.summary ?? "Edit").slice(0, 180)}`;
  }
  if (name === "library" && a.action === "reference_add") refuse("Adding reference videos by path isn't available.");
  if (name === "publish" && a.action === "add_thumbnail") refuse("Adding pictures from disk isn't available; grab_frame works.");
  if (name === "publish" && a.action === "settings_set" && (a.description_template_file !== undefined || a.thumbnail_refs !== undefined)) refuse("Template and reference files on disk can't be set.");
  if (name === "render" && a.action === "start" && a.path) refuse("Exports go to the project's exports folder; a custom path isn't available.");
  return a;
}

// ---------------------------------------------------------------------------------------------
// The door

const MAX_BODY = 4 * 1024 * 1024;
const CLIP_TTL_MS = 15 * 60_000;
const MAX_CLIPS_BYTES = 200 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("too big"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined);
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

export interface DoorStatus {
  running: boolean;
  port: number;
  error: string;
}

export class RemoteDoor {
  private server: http.Server | null = null;
  private keys: AgentKey[] = [];
  private clips = new Map<string, { data: Buffer; mime: string; until: number }>();
  private calls = new Map<string, { at: number; n: number }>();
  private lastSaved = new Map<string, number>();
  status: DoorStatus = { running: false, port: 0, error: "" };

  constructor(private local: () => { port: number; token: string }) {}

  /** Starts, stops or moves the door to match the saved settings. */
  async apply(): Promise<DoorStatus> {
    const s = await readRemote();
    this.keys = s.keys;
    this.publicUrl = s.publicUrl;
    if (!s.enabled) {
      await this.close();
      this.status = { running: false, port: s.port, error: "" };
      return this.status;
    }
    if (this.server && this.status.port === s.port) return this.status;
    await this.close();
    const server = http.createServer((req, res) => void this.handle(req, res).catch((e) => (res.headersSent ? res.destroy() : json(res, 500, { error: String(e instanceof Error ? e.message : e) }))));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        // Loopback only: the tunnel runs on this computer and connects here.
        server.listen(s.port, "127.0.0.1", () => resolve());
      });
      this.server = server;
      this.status = { running: true, port: (server.address() as AddressInfo).port, error: "" };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      this.status = { running: false, port: s.port, error: code === "EADDRINUSE" ? `Port ${s.port} is already used by another program.` : String(e instanceof Error ? e.message : e) };
    }
    return this.status;
  }

  /** Called after keys change, so a revoked key stops working at once. */
  async reloadKeys(): Promise<void> {
    this.keys = (await readRemote()).keys;
  }

  get open(): boolean {
    return this.server !== null;
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    await new Promise<void>((resolve) => {
      s.closeAllConnections();
      s.close(() => resolve());
    });
  }

  private publicUrl = "";

  private base(req: IncomingMessage): string {
    // The address the owner gave wins; otherwise the one the request came in on (tunnels pass it on).
    if (this.publicUrl) return this.publicUrl;
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? `127.0.0.1:${this.status.port}`).split(",")[0]!.trim();
    const local = /^(127\.0\.0\.1|localhost)(:|$)/.test(host);
    const proto = String(req.headers["x-forwarded-proto"] ?? (local ? "http" : "https")).split(",")[0]!.trim();
    return `${proto}://${host}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://door");
    if (url.pathname === "/" || url.pathname === "/health") {
      return json(res, 200, { ok: true, name: "Sous Chef", note: "Agents connect at /mcp with a key made in Sous Chef → Settings → Remote agents." });
    }
    const clip = /^\/clips\/([\w-]{20,64})\.(mp3|mp4)$/.exec(url.pathname);
    if (clip && req.method === "GET") {
      const c = this.clips.get(clip[1]!);
      if (!c || c.until < Date.now()) return json(res, 404, { error: "This link has expired. Ask media_clip for a new one." });
      res.writeHead(200, { "content-type": c.mime, "content-length": c.data.length, "cache-control": "no-store" });
      res.end(c.data);
      return;
    }
    if (url.pathname !== "/mcp") return json(res, 404, { error: "Not found" });

    const header = req.headers.authorization;
    const key = matchKey(this.keys, header?.startsWith("Bearer ") ? header.slice(7).trim() : null);
    if (!key) return json(res, 401, { error: "A Sous Chef agent key is needed (Settings → Remote agents)." });
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    // A plain limit per key, so a runaway agent can't flood the editor.
    const now = Date.now();
    const c = this.calls.get(key.id);
    if (c && now - c.at < 60_000) {
      if (++c.n > 600) return json(res, 429, { error: "Too many requests; slow down." });
    } else this.calls.set(key.id, { at: now, n: 1 });
    this.touch(key);

    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, { error: "The request body must be JSON under 4 MB." });
    }
    const mcp = new Server({ name: "sous-chef", version: "1.0.0" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: remoteTools() }) as never);
    mcp.setRequestHandler(CallToolRequestSchema, async (r) => (await this.call(key, r.params.name, (r.params.arguments ?? {}) as Record<string, unknown>, this.base(req))) as never);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  private touch(key: AgentKey): void {
    const last = this.lastSaved.get(key.id) ?? 0;
    if (Date.now() - last < 60_000) return;
    this.lastSaved.set(key.id, Date.now());
    void updateRemote((s) => {
      const k = s.keys.find((x) => x.id === key.id);
      if (k) k.lastUsedAt = new Date().toISOString();
    }).catch(() => undefined);
  }

  /** The editor's own API, reached on this computer with the editor's token. */
  private api(): EditApi & { raw(path: string): Promise<Response> } {
    const request = async (p: string, init: RequestInit = {}) => {
      const { port, token } = this.local();
      const res = await fetch(`http://127.0.0.1:${port}${p}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
        throw new Error(`${b?.error?.code ?? res.status}: ${b?.error?.message ?? res.statusText}`);
      }
      return res;
    };
    return {
      raw: request,
      get: async <T>(p: string) => (await (await request(p)).json()) as T,
      post: async <T>(p: string, body?: unknown) => (await (await request(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })).json()) as T,
      frame: async (p: string) => {
        const res = await request(p);
        return { jpeg: Buffer.from(await res.arrayBuffer()), mediaId: res.headers.get("x-media-id") ?? "", sourceUs: Number(res.headers.get("x-source-us") ?? 0) };
      },
    };
  }

  private async call(key: AgentKey, name: string, args: Record<string, unknown>, base: string): Promise<ToolResult> {
    const text = (v: unknown): ToolResult => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) }] });
    try {
      const folder = (await readPreferences()).projectsFolder;
      const safe = await guardCall(name, args, key.name, folder);
      const api = this.api();
      if (name === "project" && safe.action === "list") {
        const open = (await api.get<{ projects: unknown[] }>("/api/projects")).projects;
        return text({ open, projects: await ownerProjects(folder), note: "open: projects open now (use their id). projects: all of the owner's projects; open one with action 'open' and its path." });
      }
      if (name === "media_clip") return text(await this.clip(api, safe, base));
      return await callTool(api, name, safe);
    } catch (e) {
      return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
    }
  }

  private async clip(api: ReturnType<RemoteDoor["api"]>, a: Record<string, unknown>, base: string) {
    const pid = encodeURIComponent(String(a.project_id ?? ""));
    if (!pid) throw new Error("project_id is required");
    const kind = a.kind === "video" ? "video" : "audio";
    const dur = Math.max(1_000_000, Math.min(60_000_000, Math.round(Number(a.duration_us ?? 15_000_000)) || 15_000_000));
    const where =
      a.timeline_us !== undefined ? `tlUs=${Math.round(Number(a.timeline_us))}` : typeof a.media_id === "string" && a.source_us !== undefined ? `mediaId=${encodeURIComponent(a.media_id)}&us=${Math.round(Number(a.source_us))}` : null;
    if (!where) throw new Error("give timeline_us, or media_id with source_us");
    const res = await api.raw(`/api/p/${pid}/excerpt?${where}&durUs=${dur}&kind=${kind}`);
    const data = Buffer.from(await res.arrayBuffer());
    // Old links go first, so the kept clips stay small.
    const now = Date.now();
    let total = data.length;
    for (const [id, c] of [...this.clips].reverse()) {
      if (c.until < now || total + c.data.length > MAX_CLIPS_BYTES) this.clips.delete(id);
      else total += c.data.length;
    }
    const id = randomBytes(18).toString("base64url");
    const ext = kind === "video" ? "mp4" : "mp3";
    this.clips.set(id, { data, mime: kind === "video" ? "video/mp4" : "audio/mpeg", until: now + CLIP_TTL_MS });
    return {
      url: `${base}/clips/${id}.${ext}`,
      kind,
      mediaId: res.headers.get("x-media-id"),
      fromSourceUs: Number(res.headers.get("x-source-us") ?? 0),
      durationUs: dur,
      bytes: data.length,
      expires: "in 15 minutes",
    };
  }
}

export const remoteFileExists = () => existsSync(file());
