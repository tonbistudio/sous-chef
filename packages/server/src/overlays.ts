import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Overlay, Project } from "@sous-chef/core";
import type { JobHandle } from "./jobs.js";

/**
 * HyperFrames overlays. Each is a small HTML composition from a template,
 * filled in with the overlay's values and rendered by the HyperFrames CLI to a
 * transparent VP9 WebM in the project's cache. Preview plays that file over
 * the picture; export composites it with ffmpeg. A changed overlay is
 * rendered again; its old file is kept until the new one is ready.
 */
export const HYPERFRAMES = process.env.SOUS_CHEF_HYPERFRAMES ?? "hyperframes@0.6.69";
const FPS = 30;

export interface TemplateInfo {
  description: string;
  defaults: Record<string, string>;
}

export function templatesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.join(here, "..", "templates"), path.join(here, "templates"), path.join(here, "..", "..", "server", "templates")]) {
    if (existsSync(path.join(p, "templates.json"))) return p;
  }
  return path.join(here, "..", "templates");
}

export async function listTemplates(): Promise<Record<string, TemplateInfo>> {
  return JSON.parse(await readFile(path.join(templatesDir(), "templates.json"), "utf8")) as Record<string, TemplateInfo>;
}

const cacheDir = (projectDir: string) => path.join(projectDir, "cache", "overlays");

/** A timeline's frame size; graphics are drawn at it. */
export type FrameSize = [number, number];
const LANDSCAPE: FrameSize = [1920, 1080];
export const frameOf = (project: Project): FrameSize => [project.settings.width || 1920, project.settings.height || 1080];

/** What the rendered file depends on. The 16:9 key is unchanged from before timelines had sizes, so those renders stay valid. */
export function overlayKey(o: Pick<Overlay, "template" | "params" | "durationUs">, size: FrameSize = LANDSCAPE): string {
  const params = Object.entries(o.params ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const parts: unknown[] = [o.template, params, o.durationUs];
  if (size[0] !== LANDSCAPE[0] || size[1] !== LANDSCAPE[1]) parts.push(size);
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

async function keyOf(projectDir: string, id: string): Promise<string | null> {
  try {
    return (JSON.parse(await readFile(path.join(cacheDir(projectDir), `${id}.json`), "utf8")) as { key: string }).key;
  } catch {
    return null;
  }
}

function hfOverlays(project: Project): Overlay[] {
  return Object.values(project.items).filter((i): i is Overlay => i.type === "overlay" && i.kind === "hyperframes");
}

/** Rendered files that match their overlay as it is now, by overlay id. */
export async function renderedOverlays(projectDir: string, project?: Project): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!project) {
    for (const name of await readdir(cacheDir(projectDir)).catch(() => [] as string[])) {
      const m = /^([a-z0-9_-]+)\.webm$/i.exec(name);
      if (m) out[m[1]!] = path.join(cacheDir(projectDir), name);
    }
    return out;
  }
  for (const o of hfOverlays(project)) {
    const file = path.join(cacheDir(projectDir), `${o.id}.webm`);
    if (existsSync(file) && (await keyOf(projectDir, o.id)) === overlayKey(o, frameOf(project))) out[o.id] = file;
  }
  return out;
}

/** HyperFrames overlays whose file is missing or out of date. */
export async function staleOverlays(projectDir: string, project: Project): Promise<Overlay[]> {
  const fresh = await renderedOverlays(projectDir, project);
  return hfOverlays(project).filter((o) => !fresh[o.id]);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const NUMERIC = new Set(["duration", "x", "y", "w", "h", "value"]);

/** Fills a template. Values are HTML-escaped; colours and numbers are checked, so a value cannot add markup or script. */
export async function fillTemplate(template: string, params: Record<string, string>, durationUs: number, size: FrameSize = LANDSCAPE): Promise<string> {
  const templates = await listTemplates();
  const info = templates[template];
  if (!info) throw new Error(`No HyperFrames template "${template}". Available: ${Object.keys(templates).join(", ")}`);
  let html = await readFile(path.join(templatesDir(), template, "index.html"), "utf8");
  const values: Record<string, string> = { ...info.defaults, ...params, duration: (durationUs / 1e6).toFixed(3) };
  html = html.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (_, k: string) => {
    const v = String(values[k] ?? "");
    if (k === "color") return /^#[0-9a-fA-F]{6}$/.test(v) ? v : "#e8a33d";
    // Numbers (positions, sizes, a counter's value) are written as numbers, never as text.
    if (NUMERIC.has(k)) return String(Number.isFinite(Number(v)) && v.trim() !== "" ? Number(v) : 0);
    return esc(v);
  });
  // Templates are written for a 1920x1080 page; draw them at the timeline's frame size instead.
  if (size[0] !== LANDSCAPE[0] || size[1] !== LANDSCAPE[1]) html = html.replace(/(?<!\d)(1920|1080)(?!\d)/g, (n) => String(n === "1920" ? size[0] : size[1]));
  return html;
}

/** Renders one overlay to <cache>/overlays/<id>.webm. */
export async function renderOverlay(projectDir: string, o: Overlay, handle: JobHandle | null, onProgress?: (f: number) => void, size: FrameSize = LANDSCAPE): Promise<string> {
  if (!o.template) throw new Error(`Overlay ${o.id} has no template`);
  const dir = cacheDir(projectDir);
  const work = path.join(dir, `.work-${o.id}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  await writeFile(path.join(work, "index.html"), await fillTemplate(o.template, o.params ?? {}, o.durationUs, size), "utf8");
  await writeFile(path.join(work, "meta.json"), JSON.stringify({ id: `sous-${o.id}`, name: `sous-${o.id}` }), "utf8");
  await writeFile(path.join(work, "hyperframes.json"), JSON.stringify({ paths: { blocks: "compositions", components: "compositions/components", assets: "assets" } }), "utf8");
  const tmp = path.join(work, "out.webm");
  try {
    await new Promise<void>((resolve, reject) => {
      const npx = process.platform === "win32" ? "npx.cmd" : "npx";
      const child = spawn(npx, ["--yes", HYPERFRAMES, "render", "--format", "webm", "--fps", String(FPS), "--quality", "standard", "--output", "out.webm"], {
        cwd: work,
        windowsHide: true,
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HYPERFRAMES_TELEMETRY: "0", DO_NOT_TRACK: "1" },
      });
      if (handle) handle.onCancel = () => child.kill();
      let log = "";
      const read = (d: Buffer) => {
        const s = d.toString("utf8");
        log = (log + s).slice(-3000);
        const m = /(\d+)%/g;
        let hit: RegExpExecArray | null;
        let last = -1;
        while ((hit = m.exec(s))) last = Number(hit[1]);
        if (last >= 0) onProgress?.(last / 100);
      };
      child.stdout.on("data", read);
      child.stderr.on("data", read);
      child.on("error", (e) => reject(new Error(`Could not run HyperFrames: ${e.message}`)));
      child.on("close", (code) => {
        if (handle?.cancelled) reject(new Error("cancelled"));
        else if (code === 0 && existsSync(tmp)) resolve();
        else reject(new Error(`HyperFrames render failed: ${log.trim().split(/\r?\n/).slice(-3).join(" | ")}`));
      });
    });
    const file = path.join(dir, `${o.id}.webm`);
    await rename(tmp, file);
    await writeFile(path.join(dir, `${o.id}.json`), JSON.stringify({ key: overlayKey(o, size), template: o.template }), "utf8");
    return file;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
