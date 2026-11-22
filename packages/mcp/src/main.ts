#!/usr/bin/env node
/**
 * Sous Chef tools for an agent, over MCP stdio. A thin adapter: every call
 * goes to the local edit server, the same one the editor windows use, so an
 * edit made here appears in them at once.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ensureServer, type ServerInfo } from "@sous-chef/server/connect";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as builtIn from "./tools.js";
import type { EditApi } from "./tools.js";

/**
 * The tools themselves can be updated while Hermes keeps this server running:
 * in the plugin, they live in tools.mjs beside this file. When that file
 * changes, the new version is loaded and Hermes is told the tool list changed,
 * so new tools appear without restarting Hermes.
 */
type ToolsModule = Pick<typeof builtIn, "TOOLS" | "callTool">;
const here = path.dirname(fileURLToPath(import.meta.url));
const toolsFile = path.join(here, "tools.mjs");
let tools: ToolsModule = builtIn;
let loadedStamp = "";
let onToolsChanged: (() => void) | null = null;

async function currentTools(): Promise<ToolsModule> {
  if (!existsSync(toolsFile)) return tools;
  let stamp: string;
  try {
    const s = statSync(toolsFile);
    stamp = `${s.mtimeMs}-${s.size}`;
  } catch {
    return tools;
  }
  if (stamp === loadedStamp) return tools;
  try {
    const fresh = (await import(`${pathToFileURL(toolsFile).href}?v=${encodeURIComponent(stamp)}`)) as ToolsModule;
    if (Array.isArray(fresh.TOOLS) && typeof fresh.callTool === "function") {
      const first = loadedStamp === "";
      tools = fresh;
      loadedStamp = stamp;
      if (!first) onToolsChanged?.();
    }
  } catch {
    /* a half-written file: keep the tools already loaded and try again next time */
  }
  return tools;
}

let info: ServerInfo | null = null;

/** Talks to the edit server, finding or starting it on first use and again if it went away. */
async function request(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  info ??= await ensureServer();
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${info.port}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${info.token}` } });
  } catch (err) {
    info = null;
    if (retry) return request(path, init, false);
    throw err;
  }
  if (res.status === 401 && retry) {
    // The server was restarted and has a new token.
    info = null;
    return request(path, init, false);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new Error(`${body?.error?.code ?? res.status}: ${body?.error?.message ?? res.statusText}`);
  }
  return res;
}

const api: EditApi = {
  get: async <T>(path: string) => (await (await request(path)).json()) as T,
  post: async <T>(path: string, body?: unknown) =>
    (await (
      await request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })
    ).json()) as T,
  frame: async (path: string) => {
    const res = await request(path);
    return {
      jpeg: Buffer.from(await res.arrayBuffer()),
      mediaId: res.headers.get("x-media-id") ?? "",
      sourceUs: Number(res.headers.get("x-source-us") ?? 0),
    };
  },
};

const server = new Server({ name: "sous-chef", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
onToolsChanged = () => void server.sendToolListChanged().catch(() => undefined);
// ttlMs: an agent that keeps the tool list on disk (Hermes does) asks again after ten minutes,
// so tools added in an update show up instead of a stale list being used forever.
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (await currentTools()).TOOLS as unknown as never[], ttlMs: 10 * 60_000 }) as never);
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    return (await (await currentTools()).callTool(api, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>)) as never;
  } catch (err) {
    return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true } as never;
  }
});
await currentTools();
await server.connect(new StdioServerTransport());
// An agent may have registered these tools from an old list it kept on disk. Telling it once,
// right after connecting, that the list changed makes it read the real one.
setTimeout(() => onToolsChanged?.(), 3000).unref();
// Notice a newer tools file between calls too, so Hermes hears about new tools before it needs them.
setInterval(() => void currentTools(), 15_000).unref();
