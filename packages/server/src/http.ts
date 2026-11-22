import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { EditError, timelineToSource, captionCues, fillSettings, slicePlan, toSrt, type Transcripts } from "@sous-chef/core";
import { grabFrame, mimeFor } from "./media.js";
import { Exporter, type ExportJob } from "./export.js";
import { activityFor } from "./activity.js";
import { Chats, chatImagesDir, type ChatState } from "./chat.js";
import { voiceFilter } from "./voice.js";
import { speak, spokenText, transcribe } from "./talk.js";
import { judgeRetakes } from "./retakes.js";
import { captureTemplate, type Op } from "@sous-chef/core";
import { deleteTemplate, getTemplate, libraryBriefing, listTemplates as listLibraryTemplates, logProjectOpen, noteProject, readMemory, readPreferences, readProjectLog, hermesProfiles, saveTemplate, templateId, writeMemory, writePreferences } from "./library.js";
import { frameOf, listTemplates, overlayKey, renderOverlay, renderedOverlays, staleOverlays } from "./overlays.js";
import { Jobs, type Job } from "./jobs.js";
import { addThumbnail, clockLabel, descriptionTemplate, readPublish, readPublishSettings, removeThumbnail, saveThumbnailBytes, thumbnailPath, timedOutline, writePublish, writePublishSettings } from "./publish.js";
import { cutSuggestions, dropProposal, getProposal, listProposals, saveProposal, summarize, usableOps, zoomSuggestions } from "./proposals.js";
import { missingFor, prepareMedia, preparedState, proxyPath, thumbsPath, wavePath } from "./prepare.js";
import { listTranscripts, readTranscript, sidecarPython, transcribeMedia } from "./transcribe.js";
import { Store, type ChangeEvent } from "./store.js";

export const SERVER_NAME = "sous-chef";
export const SERVER_VERSION = "0.1.0";
/** When this server's code was built; a newer build replaces an idle older server. */
export const BUILD = buildStamp();
function buildStamp(): number {
  try {
    return Math.round(statSync(fileURLToPath(import.meta.url)).mtimeMs);
  } catch {
    return 0;
  }
}

export interface ServerOptions {
  port?: number;
  token: string;
  /** Folder holding the built web UI. Defaults to the ui package's dist folder. */
  uiDir?: string;
  /** Build proxies and the like automatically. On by default; tests turn it off. */
  autoPrepare?: boolean;
}

const MEDIA_EXT = new Set([
  ".mp4", ".m4v", ".mov", ".mkv", ".webm", ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg",
  ".png", ".jpg", ".jpeg", ".webp", ".gif",
]);

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".map": "application/json; charset=utf-8",
};

function defaultUiDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../ui/dist");
}

/** Lists folders, project folders and media files so the UI can offer a file picker without a native dialog. */
async function listDir(dir: string) {
  if (!dir) {
    const roots: { name: string; path: string; type: "dir" }[] = [];
    if (process.platform === "win32") {
      for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
        if (existsSync(`${letter}:\\`)) roots.push({ name: `${letter}:`, path: `${letter}:/`, type: "dir" });
      }
    } else {
      roots.push({ name: "/", path: "/", type: "dir" });
    }
    return { dir: "", parent: null, home: os.homedir().replace(/\\/g, "/"), entries: roots };
  }
  const abs = path.resolve(dir);
  let names;
  try {
    names = await readdir(abs, { withFileTypes: true });
  } catch {
    throw new HttpError(404, `Cannot read folder ${abs}`, "not_found");
  }
  type Entry = { name: string; path: string; type: "dir" | "project" | "file"; size?: number; mtimeMs?: number };
  const found = await Promise.all(
    names.map(async (d): Promise<Entry | null> => {
      if (d.name.startsWith(".") || d.name.startsWith("$")) return null;
      const full = path.join(abs, d.name).replace(/\\/g, "/");
      if (d.isDirectory()) {
        return { name: d.name, path: full, type: /\.(sous|aigedit|cutroom)$/i.test(d.name) ? "project" : "dir" };
      }
      if (!d.isFile() || !MEDIA_EXT.has(path.extname(d.name).toLowerCase())) return null;
      const info = await stat(full).catch(() => null);
      return info ? { name: d.name, path: full, type: "file", size: info.size, mtimeMs: Math.round(info.mtimeMs) } : null;
    }),
  );
  const entries = found.filter((e): e is Entry => e !== null);
  // Folders first by name; then files, newest first, because the latest takes are the ones wanted.
  entries.sort((x, y) => {
    const fx = x.type === "file" ? 1 : 0;
    const fy = y.type === "file" ? 1 : 0;
    if (fx !== fy) return fx - fy;
    if (fx) return (y.mtimeMs ?? 0) - (x.mtimeMs ?? 0);
    return x.name.localeCompare(y.name, undefined, { numeric: true });
  });
  const parent = path.dirname(abs);
  return {
    dir: abs.replace(/\\/g, "/"),
    parent: parent === abs ? "" : parent.replace(/\\/g, "/"),
    home: os.homedir().replace(/\\/g, "/"),
    entries,
  };
}

export interface RunningServer {
  port: number;
  token: string;
  store: Store;
  /** Milliseconds since the last request, or 0 while any window is connected. */
  idleMs(): number;
  exporter: Exporter;
  jobs: Jobs;
  /** Called when a client asks the server to stop. */
  onShutdown(fn: () => void): void;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(public status: number, message: string, public code = "error", public details?: unknown) {
    super(message);
  }
}

const STATUS: Record<string, number> = { stale_revision: 409, conflict: 409, not_found: 404, invalid: 400 };

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16 * 1024 * 1024) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body is not valid JSON", "invalid");
  }
}

function tokenOk(given: string | null | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requestToken(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return url.searchParams.get("token");
}

/** Serves a file with byte-range support, which video players need to seek. */
/** File names the server gives pasted chat pictures; nothing else is read from that folder. */
const CHAT_IMAGE = /^[\w-]{1,80}\.(png|jpg|webp|gif)$/;

async function sendFile(req: IncomingMessage, res: ServerResponse, file: string): Promise<void> {
  let info;
  try {
    info = await stat(file);
  } catch {
    throw new HttpError(404, "Media file is missing on disk", "not_found");
  }
  const size = info.size;
  const base = {
    "content-type": mimeFor(file),
    "accept-ranges": "bytes",
    "last-modified": info.mtime.toUTCString(),
    "cache-control": "private, max-age=3600",
  };
  const range = req.headers.range;
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === "" && m[2] === "")) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      res.end();
      return;
    }
    if (m[1] === "") {
      start = Math.max(0, size - Number(m[2]));
    } else {
      start = Number(m[1]);
      if (m[2] !== "") end = Math.min(size - 1, Number(m[2]));
    }
    if (start > end || start >= size) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      res.end();
      return;
    }
    status = 206;
  }
  const headers: Record<string, string | number> = { ...base, "content-length": end - start + 1 };
  if (status === 206) headers["content-range"] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(file, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

async function loadTranscripts(p: { dir: string; project: { media: { id: string }[] } }): Promise<Transcripts> {
  const out: Transcripts = {};
  for (const id of await listTranscripts(p.dir)) {
    if (p.project.media.some((m) => m.id === id)) out[id] = await readTranscript(p.dir, id);
  }
  return out;
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const sockets = new Set<WebSocket>();
  const broadcast = (event: ChangeEvent | { type: "export"; job: ExportJob } | { type: "job"; job: Job } | { type: "cache"; projectId: string } | { type: "proposals"; projectId: string } | { type: "chat"; projectId: string; chat: ChatState } | { type: "library" } | { type: "publish"; projectId: string }) => {
    const text = JSON.stringify(event);
    for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(text);
  };
  const store = new Store(broadcast);
  const chats = new Chats((projectId, chat) => broadcast({ type: "chat", projectId, chat }));
  const exporter = new Exporter((job) => broadcast({ type: "export", job }));
  const jobs = new Jobs((job) => broadcast({ type: "job", job }));
  /**
   * Whether nothing would be lost by stopping this server: no editor window open, no export, job or
   * chat running. Both idle exit and replacement by a newer build go by this one test.
   */
  const replaceable = (): boolean => sockets.size === 0 && !exporter.anyRunning() && !jobs.anyRunning() && !chats.anyRunning();
  let onShutdown: (() => void) | null = null;

  /** Media that could not be prepared, by project and media id, with the file as it was then. */
  const gaveUp = new Map<string, string>();
  const stamp = (file: string): string => {
    try {
      const st = statSync(file);
      return `${file}|${st.size}|${st.mtimeMs}`;
    } catch {
      return `${file}|gone`;
    }
  };
  /** Starts building proxies, sound outlines and pictures for media that lack them. */
  const prepare = (p: ReturnType<Store["get"]>): void => {
    if (options.autoPrepare === false || jobs.running(p.id, "prepare")) return;
    const items = p.project.media
      .filter((m) => Object.values(missingFor(p.dir, m)).some(Boolean))
      .map((m) => ({ media: m, file: p.mediaPath(m) }))
      // A file that is not there (the Media panel offers to find it), or that already failed as it is,
      // is not tried again until it is relinked or changes; otherwise this retried it without end.
      .filter((it) => existsSync(it.file) && gaveUp.get(`${p.id}:${it.media.id}`) !== stamp(it.file));
    if (!items.length) return;
    jobs.start("prepare", p.id, "Prepare media", (h) =>
      prepareMedia(p.dir, items, h, () => broadcast({ type: "cache", projectId: p.id }), (mediaId) => {
        // Only a file that was tried and failed waits for a change; cancelled or untried ones are tried again.
        const it = items.find((x) => x.media.id === mediaId);
        if (it) gaveUp.set(`${p.id}:${mediaId}`, stamp(it.file));
      }).finally(() => {
        // Media added while this ran still needs doing.
        setTimeout(() => {
          try {
            prepare(store.get(p.id));
          } catch {
            /* project closed */
          }
        }, 100);
      }),
    );
  };
  /** Renders HyperFrames overlays that are new or changed, one job at a time per project. */
  const renderOverlays = (p: ReturnType<Store["get"]>): void => {
    if (options.autoPrepare === false || jobs.running(p.id, "overlays")) return;
    const size = frameOf(p.project);
    void staleOverlays(p.dir, p.project).then((stale) => {
      if (!stale.length || jobs.running(p.id, "overlays")) return;
      jobs.start("overlays", p.id, `Render ${stale.length} HyperFrames overlay${stale.length === 1 ? "" : "s"}`, async (h) => {
        for (const [i, o] of stale.entries()) {
          h.update(i / stale.length, `Rendering "${o.text || o.template}"`);
          await renderOverlay(p.dir, o, h, (f) => h.update((i + f) / stale.length), size);
          broadcast({ type: "cache", projectId: p.id });
        }
        // Overlays edited while this ran still need doing.
        setTimeout(() => {
          try {
            renderOverlays(store.get(p.id));
          } catch {
            /* project closed */
          }
        }, 100);
      });
    });
  };
  const uiDir = options.uiDir ?? defaultUiDir();
  let port = 0;
  let lastActivity = Date.now();

  /** The web UI. Its files are public code; everything they call needs the token. */
  async function serveUi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
    let rel = pathname === "/" ? "index.html" : pathname.slice(1);
    let file = path.resolve(uiDir, rel);
    if (file !== uiDir && !file.startsWith(uiDir + path.sep)) throw new HttpError(403, "Forbidden");
    let info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      if (path.extname(rel)) throw new HttpError(404, "Not found", "not_found");
      rel = "index.html";
      file = path.join(uiDir, rel);
      info = await stat(file).catch(() => null);
      if (!info) throw new HttpError(503, "The web UI has not been built yet. Run: npm run build", "ui_missing");
    }
    res.writeHead(200, {
      "content-type": STATIC_MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": info.size,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  }

  const hostOk = (req: IncomingMessage) => {
    // Only answer requests addressed to loopback, so a web page cannot reach us through DNS tricks.
    const host = (req.headers.host ?? "").toLowerCase();
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (!hostOk(req)) throw new HttpError(403, "Forbidden host");

    // The Hermes page shows the editor in a sandboxed frame, whose origin is the literal "null".
    // Allowing it grants nothing by itself: every API call still needs the token.
    const origin = req.headers.origin;
    if (origin === "null" || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("access-control-allow-headers", "authorization, content-type");
      res.setHeader("access-control-allow-methods", "GET, HEAD, POST, OPTIONS");
      res.setHeader("access-control-max-age", "600");
      res.setHeader("vary", "origin");
    }
    if (method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    if (url.pathname === "/api/health") {
      return sendJson(res, 200, { ok: true, name: SERVER_NAME, version: SERVER_VERSION, build: BUILD, busy: !replaceable() });
    }
    if (parts[0] !== "api") return serveUi(req, res, url.pathname);
    if (!tokenOk(requestToken(req, url), options.token)) throw new HttpError(401, "Missing or wrong token", "unauthorized");

    if (parts[1] === "shutdown" && method === "POST") {
      sendJson(res, 200, { ok: true });
      setTimeout(() => onShutdown?.(), 50);
      return;
    }
    if (parts[1] === "fs" && parts[2] === "list" && method === "GET") {
      return sendJson(res, 200, await listDir(url.searchParams.get("dir") ?? ""));
    }
    if (parts[1] === "talk" && parts[2] === "transcribe" && method === "POST") {
      // A recording from the chat's microphone; Hermes's own speech-to-text turns it into words.
      const type = String(req.headers["content-type"] ?? "");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > 25 * 1024 * 1024) throw new HttpError(413, "That recording is too long", "invalid");
        chunks.push(chunk as Buffer);
      }
      if (size < 200) throw new HttpError(400, "Nothing was recorded", "invalid");
      try {
        return sendJson(res, 200, { text: await transcribe(Buffer.concat(chunks), type) });
      } catch (err) {
        throw new HttpError(502, err instanceof Error ? err.message : String(err), "voice");
      }
    }
    if (parts[1] === "talk" && parts[2] === "speak" && method === "POST") {
      // A reply read aloud with the profile's Hermes voice.
      const text = spokenText(String((await readJson(req)).text ?? ""));
      if (!text) throw new HttpError(400, "Nothing to say", "invalid");
      try {
        const { audio, type } = await speak(text);
        res.writeHead(200, { "content-type": type, "content-length": audio.length, "cache-control": "no-store" });
        res.end(audio);
        return;
      } catch (err) {
        throw new HttpError(502, err instanceof Error ? err.message : String(err), "voice");
      }
    }
    if (parts[1] === "hermes" && parts[2] === "profiles" && method === "GET") {
      return sendJson(res, 200, { profiles: ["default", ...(await hermesProfiles())], current: (await readPreferences()).hermesProfile || "default" });
    }
    if (parts[1] === "preferences" && method === "GET") return sendJson(res, 200, await readPreferences());
    if (parts[1] === "preferences" && method === "POST") {
      try {
        return sendJson(res, 200, await writePreferences((await readJson(req)) as never));
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err), "invalid");
      }
    }
    if (parts[1] === "library" && parts[2] === "publish" && method === "GET") {
      const s = await readPublishSettings();
      const tpl = await descriptionTemplate(s);
      return sendJson(res, 200, { ...s, fileReadable: Boolean(s.descriptionTemplateFile) && tpl.from === s.descriptionTemplateFile });
    }
    if (parts[1] === "library" && parts[2] === "publish" && method === "POST") {
      try {
        const s = await writePublishSettings((await readJson(req)) as never);
        broadcast({ type: "library" });
        return sendJson(res, 200, s);
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err), "invalid");
      }
    }
    if (parts[1] === "library" && parts.length === 2 && method === "GET") {
      return sendJson(res, 200, { memory: await readMemory(), templates: await listLibraryTemplates(), projects: await readProjectLog() });
    }
    if (parts[1] === "library" && parts[2] === "memory" && method === "POST") {
      const body = await readJson(req);
      if (typeof body.text !== "string") throw new HttpError(400, "text is required", "invalid");
      const text = await writeMemory(body.text);
      broadcast({ type: "library" });
      return sendJson(res, 200, { memory: text });
    }
    if (parts[1] === "library" && parts[2] === "templates" && parts[3] && method === "GET") {
      try {
        return sendJson(res, 200, await getTemplate(parts[3]));
      } catch (err) {
        throw new HttpError(404, err instanceof Error ? err.message : String(err), "not_found");
      }
    }
    if (parts[1] === "library" && parts[2] === "templates" && parts[3] && (method === "DELETE" || (method === "POST" && parts[4] === "delete"))) {
      await deleteTemplate(parts[3]);
      broadcast({ type: "library" });
      return sendJson(res, 200, { ok: true });
    }
    if (parts[1] === "projects" && parts.length === 2 && method === "GET") {
      return sendJson(res, 200, { projects: store.list() });
    }
    if (parts[1] === "projects" && parts[2] === "new" && method === "POST") {
      // A new, empty project by name. No video needed: import media, add text or record a voiceover later.
      const body = await readJson(req);
      const name = String(body.name ?? "").trim().replace(/[<>:"/\\|?*\x00-\x1f]+/g, " ").replace(/\s+/g, " ").replace(/[. ]+$/, "").slice(0, 100);
      if (!name) throw new HttpError(400, "Give the project a name", "invalid");
      const folder = typeof body.folder === "string" && body.folder ? body.folder : (await readPreferences()).projectsFolder;
      if (!path.isAbsolute(folder)) throw new HttpError(400, "folder must be an absolute path", "invalid");
      const dir = path.join(folder, `${name}.sous`);
      if (existsSync(dir)) throw new HttpError(409, `There is already a project called "${name}" in that folder`, "conflict");
      await mkdir(folder, { recursive: true });
      const p = await store.open(dir, true);
      await writePreferences({ projectsFolder: folder }).catch(() => undefined);
      await logProjectOpen(p.dir).catch(() => undefined);
      return sendJson(res, 200, { projectId: p.id, path: p.dir, revision: p.project.revision });
    }
    if (parts[1] === "projects" && parts[2] === "open" && method === "POST") {
      const body = await readJson(req);
      if (typeof body.path !== "string" || !body.path) throw new HttpError(400, "path is required", "invalid");
      const p = await store.open(body.path, Boolean(body.create));
      await logProjectOpen(p.dir).catch(() => undefined);
      prepare(p);
      renderOverlays(p);
      return sendJson(res, 200, { projectId: p.id, path: p.dir, revision: p.project.revision });
    }

    if (parts[1] === "p" && parts[2]) {
      const p = store.get(parts[2]);
      const rest = parts.slice(3);
      const what = rest[0];

      if (what === "project" && method === "GET") {
        return sendJson(res, 200, { projectId: p.id, path: p.dir, project: p.project, history: p.status() });
      }
      if (what === "plan" && method === "GET") {
        return sendJson(res, 200, p.plan);
      }
      if (what === "transactions" && method === "POST") {
        const result = await p.apply(await readJson(req));
        prepare(p);
        renderOverlays(p);
        return sendJson(res, 200, result);
      }
      if ((what === "undo" || what === "redo") && method === "POST") {
        const result = what === "undo" ? await p.undo() : await p.redo();
        renderOverlays(p);
        return sendJson(res, 200, result);
      }
      if (what === "recordings" && method === "POST") {
        // A voiceover recorded in the editor: saved in the project, converted to AAC so it has a proper length.
        const dir = path.join(p.dir, "recordings");
        await mkdir(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const raw = path.join(dir, `.vo-${stamp}.webm`);
        // Cleaned up unless asked not to; the untouched recording is kept beside it either way.
        const clean = url.searchParams.get("clean") !== "0";
        const out = path.join(dir, `voiceover-${stamp}.m4a`);
        let size = 0;
        const file = createWriteStream(raw);
        try {
          for await (const chunk of req) {
            size += (chunk as Buffer).length;
            if (size > 1024 * 1024 * 1024) throw new HttpError(413, "Recording too large", "invalid");
            if (!file.write(chunk)) await new Promise<void>((r) => file.once("drain", () => r()));
          }
          await new Promise<void>((resolve, reject) => file.end((e?: Error | null) => (e ? reject(e) : resolve())));
          if (size < 100) throw new HttpError(400, "The recording is empty", "invalid");
          await new Promise<void>((resolve, reject) => {
            const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", raw, "-vn", "-ac", "1", "-ar", "48000", ...(clean ? ["-af", voiceFilter()] : []), "-c:a", "aac", "-b:a", "192k", out], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
            let err = "";
            child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
            child.on("error", reject);
            child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exited with ${code}`))));
          });
        } finally {
          file.destroy();
          if (clean && existsSync(out)) {
            await mkdir(path.join(dir, "originals"), { recursive: true });
            await rename(raw, path.join(dir, "originals", `voiceover-${stamp}.webm`)).catch(() => rm(raw, { force: true }).catch(() => undefined));
          } else await rm(raw, { force: true }).catch(() => undefined);
        }
        return sendJson(res, 200, { path: out.replace(/\\/g, "/") });
      }
      if (what === "transcribe" && method === "POST") {
        if (!sidecarPython()) throw new HttpError(503, "Transcription is not set up on this computer. See sidecar/README.md.", "not_ready");
        if (jobs.running(p.id, "transcribe")) throw new HttpError(409, "A transcription is already running for this project", "conflict");
        const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
        const have = new Set(body.redo ? [] : await listTranscripts(p.dir));
        const wanted = Array.isArray(body.mediaIds) ? new Set(body.mediaIds as string[]) : null;
        const items = p.project.media
          .filter((m) => m.probe.hasAudio && (!wanted || wanted.has(m.id)) && !have.has(m.id))
          .map((m) => ({ mediaId: m.id, file: p.mediaPath(m) }));
        if (!items.length) return sendJson(res, 200, { job: null, message: "Everything is already transcribed" });
        const job = jobs.start("transcribe", p.id, `Transcribe ${items.length} file${items.length === 1 ? "" : "s"}`, (h) => transcribeMedia(p.dir, items, h));
        return sendJson(res, 200, { job });
      }
      if (what === "transcripts" && method === "GET") {
        const out: Record<string, unknown> = {};
        for (const id of await listTranscripts(p.dir)) {
          if (p.project.media.some((m) => m.id === id)) out[id] = await readTranscript(p.dir, id);
        }
        return sendJson(res, 200, { transcripts: out, ready: Boolean(sidecarPython()) });
      }
      if (what === "proposals" && !rest[1] && method === "GET") {
        return sendJson(res, 200, { proposals: await listProposals(p.dir) });
      }
      if (what === "proposals" && !rest[1] && method === "POST") {
        // Anyone can put edits up for approval instead of applying them: the agent does for large removals.
        const body = await readJson(req);
        if (!Array.isArray(body.items) || !body.items.length) throw new HttpError(400, "items is required", "invalid");
        const items = (body.items as { kind?: string; label?: string; ops?: unknown; savedUs?: number; mediaId?: string; clipId?: string; atUs?: number }[]).map((it, i) => {
          if (!Array.isArray(it.ops) || !it.ops.length) throw new HttpError(400, `items[${i}].ops is required`, "invalid");
          return { id: `s${i + 1}`, kind: (["silence", "filler", "retake", "zoom"].includes(it.kind ?? "") ? it.kind : "other") as never, label: String(it.label ?? "Edit").slice(0, 200), savedUs: Number(it.savedUs) || 0, mediaId: it.mediaId, clipId: it.clipId, atUs: it.atUs, ops: it.ops as never };
        });
        const proposal = await saveProposal(p.dir, { by: body.by === "user" ? "user" : "agent", summary: String(body.summary ?? summarize(items)).slice(0, 300), baseRevision: p.project.revision, items });
        broadcast({ type: "proposals", projectId: p.id });
        return sendJson(res, 200, proposal);
      }
      if (what === "proposals" && rest[1] && method === "POST") {
        const proposal = await getProposal(p.dir, rest[1]);
        if (!proposal) throw new HttpError(404, "No such proposal", "not_found");
        if (rest[2] === "reject") {
          await dropProposal(p.dir, proposal.id);
          broadcast({ type: "proposals", projectId: p.id });
          return sendJson(res, 200, { rejected: true });
        }
        if (rest[2] === "accept") {
          const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
          const { ops, used, skipped } = usableOps(p.project, proposal, Array.isArray(body.itemIds) ? (body.itemIds as string[]) : null);
          let result: unknown = null;
          if (ops.length) {
            await p.snapshot("before-accept").catch(() => undefined);
            result = await p.apply({ baseRevision: p.project.revision, by: proposal.by, summary: `Accept: ${proposal.summary}`.slice(0, 200), ops });
          }
          await dropProposal(p.dir, proposal.id);
          broadcast({ type: "proposals", projectId: p.id });
          prepare(p);
          renderOverlays(p);
      renderOverlays(p);
        renderOverlays(p);
          return sendJson(res, 200, { accepted: used, skipped, result });
        }
      }
      if (what === "roughcut" && method === "POST") {
        if (jobs.running(p.id, "roughcut")) throw new HttpError(409, "A rough cut is already being worked out", "conflict");
        const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
        const wantZooms = body.zooms !== false;
        const wantCuts = body.cuts !== false;
        // Zooms on their own are "Auto zoom": they do not replace a rough cut waiting for an answer.
        const title = wantCuts ? "Rough cut" : "Auto zoom";
        const job = jobs.start("roughcut", p.id, title, async (h) => {
          const transcripts: Record<string, Awaited<ReturnType<typeof readTranscript>>> = {};
          for (const id of await listTranscripts(p.dir)) transcripts[id] = await readTranscript(p.dir, id);
          const project = p.project;
          // Flubbed lines are found by reading the transcript, which Hermes does; without Hermes the word-matching finder works alone.
          let judged: Awaited<ReturnType<typeof judgeRetakes>> = [];
          if (wantCuts && body.smart !== false) {
            h.update(0.02, "Hermes is reading the transcript for flubbed lines");
            judged = await judgeRetakes(project, transcripts, p.dir, (done, total) => h.update(0.02 + (done / total) * 0.3, `Hermes is reading the transcript for flubbed lines${total > 1 ? ` (part ${done + 1} of ${total})` : ""}`));
          }
          const readByHermes = judged !== null;
          const cuts = wantCuts ? cutSuggestions(project, transcripts, { ...((body.options ?? {}) as object), judged: judged ?? [] } as never) : [];
          let zooms: ReturnType<typeof zoomSuggestions> = [];
          if (wantZooms) {
            const main = project.tracks.find((t) => t.kind === "main");
            const ids = [...new Set((main?.items ?? []).map((id) => project.items[id]).flatMap((c) => (c?.type === "clip" ? [c.mediaId] : [])))];
            const activity: Record<string, Awaited<ReturnType<typeof activityFor>>> = {};
            for (const [i, mediaId] of ids.entries()) {
              const media = project.media.find((m) => m.id === mediaId);
              if (!media?.probe.hasVideo) continue;
              h.update((i / ids.length) * 0.95, `Looking for what to zoom in on in ${path.basename(media.path)}`);
              // The proxy decodes far faster and shows the same picture.
              const proxy = proxyPath(p.dir, mediaId);
              activity[mediaId] = await activityFor(p.dir, mediaId, existsSync(proxy) ? proxy : p.mediaPath(media), media.durationUs, h, (f) => h.update(((i + f) / ids.length) * 0.95));
            }
            zooms = zoomSuggestions(project, cuts, activity, cuts.length);
          }
          const items = [...cuts, ...zooms];
          if (!items.length) return { proposal: null, summary: wantCuts ? "Nothing to suggest" : "No good places to zoom found" };
          // One of each at a time: a new one replaces an older one nobody answered.
          for (const old of await listProposals(p.dir)) if (old.summary.startsWith(title)) await dropProposal(p.dir, old.id);
          const proposal = await saveProposal(p.dir, { by: body.by === "agent" ? "agent" : "user", summary: `${title}: ${summarize(items)}`, baseRevision: project.revision, items });
          broadcast({ type: "proposals", projectId: p.id });
          return { proposal: proposal.id, summary: proposal.summary, items: items.length, ...(readByHermes ? {} : { note: "Hermes could not be reached, so reworded retakes were not looked for." }) };
        });
        return sendJson(res, 200, { job });
      }
      if (what === "activity" && rest[1] && method === "GET") {
        const media = p.project.media.find((m) => m.id === rest[1]);
        if (!media?.probe.hasVideo) throw new HttpError(404, `No video "${rest[1]}"`, "not_found");
        const proxy = proxyPath(p.dir, media.id);
        const all = await activityFor(p.dir, media.id, existsSync(proxy) ? proxy : p.mediaPath(media), media.durationUs, null);
        const from = Number(url.searchParams.get("fromUs") ?? 0);
        const to = Number(url.searchParams.get("toUs") ?? Number.MAX_SAFE_INTEGER);
        return sendJson(res, 200, { mediaId: media.id, activity: all.filter((a) => a.endUs > from && a.startUs < to) });
      }
      if (what === "cache" && method === "GET") {
        return sendJson(res, 200, { media: await preparedState(p.dir, p.project.media) });
      }
      if (what === "prepare" && method === "POST") {
        prepare(p);
      renderOverlays(p);
        renderOverlays(p);
        return sendJson(res, 200, { job: jobs.running(p.id, "prepare") ?? null });
      }
      if ((what === "wave" || what === "thumbs") && rest[1] && method === "GET") {
        const media = p.project.media.find((m) => m.id === rest[1]);
        if (!media) throw new HttpError(404, `No media "${rest[1]}"`, "not_found");
        const file = what === "wave" ? wavePath(p.dir, media.id) : thumbsPath(p.dir, media.id);
        if (!existsSync(file)) throw new HttpError(404, "Not built yet", "not_found");
        return sendFile(req, res, file);
      }
      if (what === "jobs" && !rest[1] && method === "GET") {
        return sendJson(res, 200, { jobs: jobs.list(p.id) });
      }
      if (what === "jobs" && rest[1]) {
        const job = jobs.get(rest[1]);
        if (!job || job.projectId !== p.id) throw new HttpError(404, "No such job", "not_found");
        if (rest[2] === "cancel" && method === "POST") jobs.cancel(job.id);
        return sendJson(res, 200, job);
      }
      if (what === "export" && !rest[1] && method === "POST") {
        const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
        const name = path.basename(p.dir).replace(/\.(sous|aigedit|cutroom)$/i, "");
        // With more than one timeline, the file says which one it is: "REA-6.10 - Short 1 - r99.mp4".
        const many = (p.project.timelines ?? []).length > 0;
        const tlName = (p.project.timelineName ?? "").replace(/[<>:"/\\|?*\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
        const file = many && tlName ? `${name} - ${tlName} - r${p.project.revision}.mp4` : `${name}-r${p.project.revision}.mp4`;
        let out = typeof body.path === "string" && body.path ? body.path : path.join(p.dir, "exports", file);
        if (!path.isAbsolute(out)) throw new HttpError(400, "path must be absolute", "invalid");
        if (!/\.(mp4|mov|mkv)$/i.test(out)) out += ".mp4";
        // Never write over footage the project uses.
        const target = path.resolve(out).toLowerCase();
        if (p.project.media.some((m) => path.resolve(p.mediaPath(m)).toLowerCase() === target)) {
          throw new HttpError(400, "That file is one of the project's source files", "invalid");
        }
        const used = new Set(p.plan.segments.map((sg) => sg.mediaId));
        const gone = p.project.media.filter((m) => used.has(m.id) && !existsSync(p.mediaPath(m)));
        if (gone.length) {
          throw new HttpError(409, `Cannot export: ${gone.length === 1 ? "a file is" : `${gone.length} files are`} missing (${gone.map((m) => path.basename(m.path)).join(", ")}). Use Find… in the Media panel to locate ${gone.length === 1 ? "it" : "them"}.`, "missing_media");
        }
        const stale = await staleOverlays(p.dir, p.project);
        if (stale.length) {
          renderOverlays(p);
          throw new HttpError(409, `${stale.length} HyperFrames overlay${stale.length === 1 ? " is" : "s are"} still being rendered. Export again when the "Render overlays" job finishes.`, "not_ready");
        }
        let plan = p.plan;
        const paths = new Map(p.project.media.map((m) => [m.id, p.mediaPath(m)]));
        const settings = fillSettings(JSON.parse(JSON.stringify(p.project)) as typeof p.project).settings;
        const cues = settings.captions.enabled ? captionCues(p.project, await loadTranscripts(p), plan) : [];
        // Optionally just a stretch of the timeline, for checking a part before the full render.
        if (typeof body.fromUs === "number" || typeof body.toUs === "number") {
          const from = Math.max(0, Math.round(Number(body.fromUs ?? 0)));
          const to = Math.min(plan.durationUs, Math.round(Number(body.toUs ?? plan.durationUs)));
          if (!(to - from >= 100_000)) throw new HttpError(400, "The range must be at least 0.1 s long", "invalid");
          plan = slicePlan(plan, from, to);
          for (const c of cues) {
            c.startUs -= from;
            c.endUs -= from;
          }
        }
        try {
          const job = await exporter.start(p.id, plan, (id) => paths.get(id)!, out, {
            cues,
            captions: settings.captions,
            normalizeLufs: settings.audio.normalize ? settings.audio.targetLufs : null,
            overlayFiles: await renderedOverlays(p.dir, p.project),
          });
          return sendJson(res, 200, job);
        } catch (err) {
          throw new HttpError(409, err instanceof Error ? err.message : String(err), "conflict");
        }
      }
      if (what === "chat" && !rest[1] && method === "GET") {
        return sendJson(res, 200, await chats.state(p.id, p.dir));
      }
      if (what === "chat" && !rest[1] && method === "POST") {
        const body = await readJson(req);
        const hasImages = Array.isArray(body.images) && body.images.length > 0;
        const text = String(body.text ?? "").trim() || (hasImages ? "(see the picture)" : "");
        if (!text) throw new HttpError(400, "text is required", "invalid");
        if (text.length > 8000) throw new HttpError(400, "That message is too long", "invalid");
        // What Hermes needs to know to act on the right thing. Only plain facts from the editor go in.
        const say = (v: unknown, max = 80) => String(v ?? "").replace(/[\r\n\[\]]/g, " ").slice(0, max);
        const at = Number(body.playheadUs);
        const context = [
          `[Sous Chef editor context. project_id=${p.id}; project folder=${p.dir.replace(/\\/g, "/")}; open timeline="${say(p.project.timelineName)}" (${say(p.project.timelineId, 64)}); revision=${p.project.revision}; length=${(p.plan.durationUs / 1e6).toFixed(1)}s` +
            (Number.isFinite(at) ? `; playhead at ${(at / 1e6).toFixed(2)}s` : "") +
            (body.selected ? `; selected: ${say(body.selected, 120)}` : "") +
            (body.marks ? `; the user marked up the frame (the attached picture shows the preview with their drawing on it; positions are fractions of the frame, 0,0 top-left): ${say(body.marks, 1200)}` : "") +
            `; tracks: ${p.project.tracks.map((t) => `${say(t.name, 30)} (${t.kind}, ${t.items.length} item${t.items.length === 1 ? "" : "s"})`).join(", ")}` +
            `. The user is typing in the editor's chat tab. Act on this project with the Sous Chef tools (server "sous_chef": project, transcript, edit_apply, suggest, frame_get, history, render, library, publish), reading the project first. Edits appear in the editor at once. Thumbnails you make for this video: save the image files in ${path.join(p.dir, "publish", "thumbnails").replace(/\\/g, "/")}/ (or add them with the publish tool); anything there shows in the editor's Publish view. Reply briefly in plain language.]`,
        ].join("");
        const images = Array.isArray(body.images) ? body.images.map(String).filter((f: string) => CHAT_IMAGE.test(f) && existsSync(path.join(chatImagesDir(p.dir), f))).slice(0, 8) : [];
        try {
          await chats.send(p.id, p.dir, text, context, () => libraryBriefing(p.dir), images);
        } catch (err) {
          throw new HttpError(409, err instanceof Error ? err.message : String(err), "conflict");
        }
        return sendJson(res, 200, await chats.state(p.id, p.dir));
      }
      if (what === "chat" && rest[1] === "images" && !rest[2] && method === "POST") {
        // A picture pasted or dropped into the chat, sent as the raw file.
        const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
        const ext = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" } as Record<string, string>)[type];
        if (!ext) throw new HttpError(415, "Only PNG, JPEG, WebP or GIF pictures can be added to the chat", "invalid");
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > 20 * 1024 * 1024) throw new HttpError(413, "That picture is too big (over 20 MB)", "invalid");
          chunks.push(chunk as Buffer);
        }
        if (!size) throw new HttpError(400, "The picture is empty", "invalid");
        const dir = chatImagesDir(p.dir);
        await mkdir(dir, { recursive: true });
        const file = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${randomBytes(3).toString("hex")}.${ext}`;
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path.join(dir, file), Buffer.concat(chunks));
        return sendJson(res, 200, { file, path: path.join(dir, file).replace(/\\/g, "/") });
      }
      if (what === "chat" && rest[1] === "images" && rest[2] && (method === "GET" || method === "HEAD")) {
        const f = decodeURIComponent(rest[2]);
        if (!CHAT_IMAGE.test(f)) throw new HttpError(404, "No such picture", "not_found");
        return sendFile(req, res, path.join(chatImagesDir(p.dir), f));
      }
      if (what === "chat" && rest[1] === "stop" && method === "POST") {
        chats.stop(p.id);
        return sendJson(res, 200, { ok: true });
      }
      if (what === "chat" && rest[1] === "clear" && method === "POST") {
        await chats.clear(p.id, p.dir);
        return sendJson(res, 200, await chats.state(p.id, p.dir));
      }
      if (what === "library" && rest[1] === "capture" && method === "POST") {
        // Saves a stretch of the open timeline as a template.
        const body = await readJson(req);
        const name = String(body.name ?? "").trim().slice(0, 80);
        if (!name) throw new HttpError(400, "A template needs a name", "invalid");
        let cap: ReturnType<typeof captureTemplate>;
        try {
          cap = captureTemplate(p.project, Number(body.fromUs), Number(body.toUs), name);
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err), "invalid");
        }
        const media = cap.mediaIds.flatMap((id) => {
          const m = p.project.media.find((x) => x.id === id);
          return m ? [{ id, path: p.mediaPath(m).replace(/\\/g, "/"), kind: m.kind }] : [];
        });
        const saved = await saveTemplate(
          {
            schema: 1, id: templateId(name), name, description: String(body.description ?? "").slice(0, 300), createdAt: new Date().toISOString(),
            lengthUs: cap.lengthUs, contents: cap.contents, media, tracks: cap.body.tracks as never, hasMain: cap.hasMain,
            ...({ mainSpeed: cap.body.mainSpeed, markers: cap.body.markers } as object),
          },
          Boolean(body.replace),
        );
        broadcast({ type: "library" });
        return sendJson(res, 200, { id: saved.id, name: saved.name, contents: saved.contents, lengthUs: saved.lengthUs });
      }
      if (what === "library" && rest[1] === "insert" && method === "POST") {
        // Drops a template in, as one undo step: files it needs are added to the project first.
        const body = await readJson(req);
        let t: Awaited<ReturnType<typeof getTemplate>>;
        try {
          t = await getTemplate(String(body.templateId ?? ""));
        } catch (err) {
          throw new HttpError(404, err instanceof Error ? err.message : String(err), "not_found");
        }
        const ops: Op[] = [];
        const map = new Map<string, string>();
        const missing: string[] = [];
        for (const m of t.media) {
          const key = m.path.replace(/\\/g, "/").toLowerCase();
          const have = p.project.media.find((x) => p.mediaPath(x).replace(/\\/g, "/").toLowerCase() === key);
          if (have) map.set(m.id, have.id);
          else if (existsSync(m.path)) {
            const id = `m${randomBytes(4).toString("hex")}`;
            ops.push({ op: "media.add", media: { id, path: m.path } as never });
            map.set(m.id, id);
          } else missing.push(m.path);
        }
        const tracks = t.tracks.map((tr) => ({
          ...tr,
          items: (tr.items as { type: string; mediaId?: string }[]).flatMap((it) => (it.type === "clip" ? (map.has(it.mediaId!) ? [{ ...it, mediaId: map.get(it.mediaId!) }] : []) : [it])),
        }));
        const extra = t as unknown as { mainSpeed?: number; markers?: unknown[] };
        ops.push({ op: "template.insert", template: { name: t.name, mainSpeed: extra.mainSpeed ?? 1, tracks: tracks as never, markers: (extra.markers ?? []) as never }, ...(Number.isFinite(Number(body.atUs)) ? { atUs: Math.max(0, Math.round(Number(body.atUs))) } : {}) });
        const result = await p.apply({ baseRevision: p.project.revision, by: body.by === "agent" ? "agent" : "user", summary: `Insert template: ${t.name}`, ops } as never);
        prepare(p);
        renderOverlays(p);
        return sendJson(res, 200, { ...(result as object), ...(missing.length ? { missingFiles: missing } : {}) });
      }
      if (what === "library" && rest[1] === "note" && method === "POST") {
        const body = await readJson(req);
        await noteProject(p.dir, String(body.note ?? ""));
        return sendJson(res, 200, { ok: true });
      }
      if (what === "publish") {
        const changed = (data: unknown) => {
          broadcast({ type: "publish", projectId: p.id });
          return sendJson(res, 200, data);
        };
        const bad = (err: unknown) => new HttpError(400, err instanceof Error ? err.message : String(err), "invalid");
        if (!rest[1] && method === "GET") {
          const markers = [...p.project.markers].sort((a, b) => a.timeUs - b.timeUs).map((m) => ({ at: clockLabel(m.timeUs), timeUs: m.timeUs, label: m.label ?? "" }));
          return sendJson(res, 200, { ...(await readPublish(p.dir)), lengthUs: p.plan.durationUs, markers });
        }
        if (!rest[1] && method === "POST") {
          try {
            return changed(await writePublish(p.dir, (await readJson(req)) as never));
          } catch (err) {
            throw bad(err);
          }
        }
        if (rest[1] === "brief" && method === "GET") {
          // Everything the agent needs to write the description and make thumbnails, in one read.
          const s = await readPublishSettings();
          const tpl = await descriptionTemplate(s);
          const data = await readPublish(p.dir);
          const outline = timedOutline(captionCues(p.project, await loadTranscripts(p), p.plan));
          const markers = [...p.project.markers].sort((a, b) => a.timeUs - b.timeUs).map((m) => `${clockLabel(m.timeUs)} ${m.label ?? ""}`.trim());
          return sendJson(res, 200, {
            project: path.basename(p.dir).replace(/\.(sous|aigedit|cutroom)$/i, ""),
            finishedLength: clockLabel(p.plan.durationUs),
            note: "Times below are in the finished video (after cuts and speed), so they can be used as chapter times directly.",
            descriptionTemplate: tpl.text || "(none saved; ask the owner or use their description skill)",
            descriptionTemplateFrom: tpl.from || "none",
            thumbnailStyle: s.thumbnailStyle || "(none saved)",
            thumbnailReferences: s.thumbnailRefs,
            channelName: s.channelName,
            current: { title: data.title, titles: data.titles, description: data.description, thumbnails: data.thumbnails.map((t) => ({ ...t, path: path.join(p.dir, "publish", "thumbnails", t.file).replace(/\\/g, "/") })), chosen: data.chosen ?? null },
            markers,
            outline: outline || "(no transcript yet)",
          });
        }
        if (rest[1] === "thumbnails" && !rest[2] && method === "POST") {
          const body = await readJson(req);
          try {
            const r = await addThumbnail(p.dir, String(body.path ?? ""), String(body.note ?? ""), body.by === "agent" ? "agent" : "user", Boolean(body.choose));
            return changed({ file: r.file, path: path.join(p.dir, "publish", "thumbnails", r.file).replace(/\\/g, "/"), ...r.data });
          } catch (err) {
            throw bad(err);
          }
        }
        if (rest[1] === "thumbnails" && rest[2] === "frame" && method === "POST") {
          // A full-size still of the main video at a timeline time, as a starting point.
          const body = await readJson(req);
          const hit = timelineToSource(p.plan, Number(body.tlUs));
          if (!hit) throw new HttpError(404, "Nothing plays on the main track at that time", "not_found");
          const media = p.project.media.find((m) => m.id === hit.segment.mediaId)!;
          const jpeg = await grabFrame(p.mediaPath(media), hit.srcUs, Math.min(1920, media.probe.width || 1280));
          const r = await saveThumbnailBytes(p.dir, jpeg, "jpg", String(body.note ?? `Frame at ${clockLabel(Number(body.tlUs))}`), body.by === "agent" ? "agent" : "user");
          return changed({ file: r.file, path: path.join(p.dir, "publish", "thumbnails", r.file).replace(/\\/g, "/"), ...r.data });
        }
        if (rest[1] === "thumbnails" && rest[2] && rest[3] === "delete" && method === "POST") {
          try {
            return changed(await removeThumbnail(p.dir, decodeURIComponent(rest[2])));
          } catch (err) {
            throw bad(err);
          }
        }
        if (rest[1] === "thumbnails" && rest[2] && (method === "GET" || method === "HEAD")) {
          const file = thumbnailPath(p.dir, decodeURIComponent(rest[2]));
          if (!file) throw new HttpError(404, "No such thumbnail", "not_found");
          return sendFile(req, res, file);
        }
      }
      if (what === "missing" && method === "GET") {
        const missing = p.project.media.filter((m) => !existsSync(p.mediaPath(m))).map((m) => ({ mediaId: m.id, path: m.path }));
        return sendJson(res, 200, { missing });
      }
      if (what === "overlay-state" && method === "GET") {
        const fresh = await renderedOverlays(p.dir, p.project);
        const rendered: Record<string, string> = {};
        for (const id of Object.keys(fresh)) {
          const o = p.project.items[id];
          if (o?.type === "overlay") rendered[id] = overlayKey(o, frameOf(p.project));
        }
        return sendJson(res, 200, { rendered });
      }
      if (what === "templates" && method === "GET") {
        return sendJson(res, 200, { templates: await listTemplates() });
      }
      if (what === "overlays" && rest[1] && method === "GET") {
        const files = await renderedOverlays(p.dir, p.project);
        const file = files[rest[1]];
        if (!file) throw new HttpError(404, "Not rendered yet", "not_found");
        return sendFile(req, res, file);
      }
      if (what === "captions" && method === "GET") {
        const cues = captionCues(p.project, await loadTranscripts(p), p.plan);
        if (url.searchParams.get("format") === "srt") {
          res.writeHead(200, { "Content-Type": "application/x-subrip; charset=utf-8", "Content-Disposition": `attachment; filename="${path.basename(p.dir).replace(/\.(sous|aigedit|cutroom)$/i, "")}.srt"` });
          return void res.end(toSrt(cues));
        }
        return sendJson(res, 200, { cues });
      }
      if (what === "export" && !rest[1] && method === "GET") {
        return sendJson(res, 200, { jobs: exporter.list(p.id) });
      }
      if (what === "export" && rest[1]) {
        const job = exporter.get(rest[1]);
        if (!job || job.projectId !== p.id) throw new HttpError(404, "No such export", "not_found");
        if (rest[2] === "cancel" && method === "POST") exporter.cancel(job.id);
        else if (method !== "GET") throw new HttpError(405, "Method not allowed");
        return sendJson(res, 200, job);
      }
      if (what === "media" && rest[1] && (method === "GET" || method === "HEAD")) {
        const media = p.project.media.find((m) => m.id === rest[1]);
        if (!media) throw new HttpError(404, `No media "${rest[1]}"`, "not_found");
        // The proxy when asked for and built; otherwise the take itself.
        const proxy = url.searchParams.get("proxy") === "1" ? proxyPath(p.dir, media.id) : null;
        return sendFile(req, res, proxy && existsSync(proxy) ? proxy : p.mediaPath(media));
      }
      if (what === "frame" && method === "GET") {
        const width = Number(url.searchParams.get("width") ?? 960);
        let mediaId = url.searchParams.get("mediaId");
        let us = Number(url.searchParams.get("us"));
        const tl = url.searchParams.get("tlUs");
        if (tl !== null) {
          const hit = timelineToSource(p.plan, Number(tl));
          if (!hit) throw new HttpError(404, "Nothing plays on the main track at that time", "not_found");
          mediaId = hit.segment.mediaId;
          us = hit.srcUs;
        }
        const media = p.project.media.find((m) => m.id === mediaId);
        if (!media) throw new HttpError(404, `No media "${mediaId}"`, "not_found");
        if (!media.probe.hasVideo) throw new HttpError(400, "That media has no picture", "invalid");
        if (!Number.isFinite(us) || us < 0 || (media.durationUs > 0 && us > media.durationUs)) {
          throw new HttpError(400, "Time is outside the media", "invalid");
        }
        const jpeg = await grabFrame(p.mediaPath(media), us, width);
        res.writeHead(200, {
          "content-type": "image/jpeg",
          "content-length": jpeg.length,
          "cache-control": "no-store",
          "x-media-id": media.id,
          "x-source-us": String(Math.round(us)),
        });
        res.end(jpeg);
        return;
      }
    }
    throw new HttpError(404, "Not found", "not_found");
  }

  const server = http.createServer((req, res) => {
    lastActivity = Date.now();
    route(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof EditError) {
        sendJson(res, STATUS[err.code] ?? 400, { error: { code: err.code, message: err.message, details: err.details } });
      } else if (err instanceof HttpError) {
        sendJson(res, err.status, { error: { code: err.code, message: err.message } });
      } else {
        sendJson(res, 500, { error: { code: "internal", message: err instanceof Error ? err.message : String(err) } });
      }
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/ws" || !hostOk(req) || !tokenOk(url.searchParams.get("token"), options.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on("close", () => {
        sockets.delete(ws);
        lastActivity = Date.now();
      });
      ws.on("error", () => sockets.delete(ws));
      ws.send(JSON.stringify({ type: "hello", name: SERVER_NAME, version: SERVER_VERSION, projects: store.list() }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;

  return {
    port,
    token: options.token,
    store,
    idleMs: () => (replaceable() ? Date.now() - lastActivity : 0),
    exporter,
    jobs,
    onShutdown: (fn: () => void) => {
      onShutdown = fn;
    },
    close: () =>
      new Promise<void>((resolve) => {
        exporter.stopAll();
        jobs.stopAll();
        chats.stopAll();
        for (const ws of sockets) ws.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
