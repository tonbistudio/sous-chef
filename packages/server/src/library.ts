import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { homeDir } from "./connect.js";

/**
 * What the editor keeps between projects, in the app's home folder:
 *
 *  - preferences.json: the owner's defaults for new projects (speed).
 *  - library/memory.md: what the agent has learned about how the owner edits,
 *    written by the agent and readable and editable by the owner.
 *  - library/templates/*.json: reusable pieces of a timeline (an intro, a
 *    lower third, a picture-in-picture layout, an outro) saved from a project
 *    and dropped into others.
 *  - library/projects.json: a short log of projects worked on, so the agent
 *    knows what came before.
 */
export interface Preferences {
  /** Speed new projects start at. */
  newProjectSpeed: number;
  /** Where new projects are made unless another folder is picked. */
  projectsFolder: string;
  /** Hermes profile the editor talks to (chat, rough cut). Empty: the user's default profile. */
  hermesProfile: string;
  /** Loudness new projects level to on export, in LUFS; null: new projects do not level. */
  newProjectLufs: number | null;
}

export const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const DEFAULT_PREFS: Preferences = { newProjectSpeed: 1, newProjectLufs: null, hermesProfile: "", projectsFolder: path.join(os.homedir(), "Documents", "Sous Chef") };

export function libraryDir(): string {
  return path.join(homeDir(), "library");
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rm(file, { force: true }).catch(() => undefined);
  const { rename } = await import("node:fs/promises");
  await rename(tmp, file);
}

export async function readPreferences(): Promise<Preferences> {
  const saved = await readJson<Partial<Preferences>>(path.join(homeDir(), "preferences.json"), {});
  const speed = Number(saved.newProjectSpeed);
  const folder = typeof saved.projectsFolder === "string" && path.isAbsolute(saved.projectsFolder) ? saved.projectsFolder : DEFAULT_PREFS.projectsFolder;
  const profile = typeof saved.hermesProfile === "string" && PROFILE_NAME.test(saved.hermesProfile) ? saved.hermesProfile : "";
  const lufs = saved.newProjectLufs === null || saved.newProjectLufs === undefined ? null : Number(saved.newProjectLufs);
  return {
    ...DEFAULT_PREFS, hermesProfile: profile, projectsFolder: folder.replace(/\\/g, "/"),
    ...(speed >= 0.25 && speed <= 4 ? { newProjectSpeed: speed } : {}),
    ...(lufs !== null && lufs >= -30 && lufs <= -8 ? { newProjectLufs: lufs } : {}),
  };
}

export async function writePreferences(patch: Partial<Preferences>): Promise<Preferences> {
  const next = { ...(await readPreferences()) };
  if (patch.newProjectSpeed !== undefined) {
    const s = Number(patch.newProjectSpeed);
    if (!(s >= 0.25 && s <= 4)) throw new Error("newProjectSpeed must be between 0.25 and 4");
    next.newProjectSpeed = Math.round(s * 1000) / 1000;
  }
  if (patch.newProjectLufs !== undefined) {
    const v = patch.newProjectLufs === null ? null : Number(patch.newProjectLufs);
    if (v !== null && !(v >= -30 && v <= -8)) throw new Error("newProjectLufs must be between -30 and -8, or null");
    next.newProjectLufs = v;
  }
  if (patch.projectsFolder !== undefined) {
    if (typeof patch.projectsFolder !== "string" || !path.isAbsolute(patch.projectsFolder)) throw new Error("projectsFolder must be an absolute folder path");
    next.projectsFolder = patch.projectsFolder.replace(/\\/g, "/");
  }
  if (patch.hermesProfile !== undefined) {
    const name = String(patch.hermesProfile ?? "").trim();
    if (name && name !== "default" && !PROFILE_NAME.test(name)) throw new Error("Not a Hermes profile name");
    next.hermesProfile = name === "default" ? "" : name;
  }
  await writeJson(path.join(homeDir(), "preferences.json"), next);
  return next;
}

// ---------------------------------------------------------------- memory

const MEMORY_LIMIT = 20_000;

export async function readMemory(): Promise<string> {
  try {
    return await readFile(path.join(libraryDir(), "memory.md"), "utf8");
  } catch {
    return "";
  }
}

export async function writeMemory(text: string): Promise<string> {
  const body = String(text ?? "").slice(0, MEMORY_LIMIT);
  await mkdir(libraryDir(), { recursive: true });
  await writeFile(path.join(libraryDir(), "memory.md"), body, "utf8");
  return body;
}

// ---------------------------------------------------------------- project log

export interface ProjectLogEntry {
  path: string;
  name: string;
  firstOpened: string;
  lastOpened: string;
  /** A line the agent writes when it finishes a session on the project. */
  note?: string;
}

export async function readProjectLog(): Promise<ProjectLogEntry[]> {
  return readJson<ProjectLogEntry[]>(path.join(libraryDir(), "projects.json"), []);
}

export async function logProjectOpen(dir: string): Promise<void> {
  const log = await readProjectLog();
  const key = dir.replace(/\\/g, "/").toLowerCase();
  const now = new Date().toISOString();
  const hit = log.find((e) => e.path.replace(/\\/g, "/").toLowerCase() === key);
  if (hit) hit.lastOpened = now;
  else log.push({ path: dir.replace(/\\/g, "/"), name: path.basename(dir).replace(/\.(sous|aigedit|cutroom)$/i, ""), firstOpened: now, lastOpened: now });
  log.sort((a, b) => b.lastOpened.localeCompare(a.lastOpened));
  await writeJson(path.join(libraryDir(), "projects.json"), log.slice(0, 200));
}

export async function noteProject(dir: string, note: string): Promise<void> {
  const log = await readProjectLog();
  const key = dir.replace(/\\/g, "/").toLowerCase();
  const hit = log.find((e) => e.path.replace(/\\/g, "/").toLowerCase() === key);
  if (!hit) return;
  hit.note = String(note).replace(/\s+/g, " ").trim().slice(0, 400);
  await writeJson(path.join(libraryDir(), "projects.json"), log);
}

// ---------------------------------------------------------------- templates

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  lengthUs: number;
  /** What is in it, e.g. "2 text, 1 graphic, 1 picture". */
  contents: string;
}

/** A template: a small timeline of its own, with the files its clips use. */
export interface Template extends TemplateSummary {
  schema: 1;
  /** Files used, by the id the items refer to. */
  media: { id: string; path: string; kind: string }[];
  tracks: { kind: string; name: string; items: unknown[] }[];
  /** Includes main-track clips: inserting it pushes later content right. */
  hasMain: boolean;
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function templatesDir(): string {
  return path.join(libraryDir(), "templates");
}

export function templateId(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "template";
  return base;
}

export async function listTemplates(): Promise<TemplateSummary[]> {
  if (!existsSync(templatesDir())) return [];
  const out: TemplateSummary[] = [];
  for (const f of await readdir(templatesDir())) {
    if (!f.endsWith(".json")) continue;
    const t = await readJson<Template | null>(path.join(templatesDir(), f), null);
    if (t && t.id) out.push({ id: t.id, name: t.name, description: t.description, createdAt: t.createdAt, lengthUs: t.lengthUs, contents: t.contents });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getTemplate(id: string): Promise<Template> {
  if (!ID.test(id)) throw new Error(`No template "${id}"`);
  const t = await readJson<Template | null>(path.join(templatesDir(), `${id}.json`), null);
  if (!t) throw new Error(`No template "${id}"`);
  return t;
}

export async function saveTemplate(t: Template, replace = false): Promise<Template> {
  let id = ID.test(t.id) ? t.id : templateId(t.name);
  if (!replace) {
    let n = 2;
    const base = id;
    while (existsSync(path.join(templatesDir(), `${id}.json`))) id = `${base}-${n++}`;
  }
  const saved = { ...t, id };
  await writeJson(path.join(templatesDir(), `${id}.json`), saved);
  return saved;
}

export async function deleteTemplate(id: string): Promise<void> {
  if (!ID.test(id)) throw new Error(`No template "${id}"`);
  await rm(path.join(templatesDir(), `${id}.json`), { force: true });
}

/** What the agent is told at the start of a chat: what it remembers, the templates, and recent projects. */
export async function libraryBriefing(currentDir: string): Promise<string> {
  const [memory, templates, log] = await Promise.all([readMemory(), listTemplates(), readProjectLog()]);
  const here = currentDir.replace(/\\/g, "/").toLowerCase();
  const recent = log.filter((e) => e.path.toLowerCase() !== here).slice(0, 8);
  const parts: string[] = [];
  parts.push(memory.trim() ? `Your editor memory (what you learned from earlier projects; keep it current with the library tool):\n${memory.trim().slice(0, 6000)}` : "Your editor memory is empty so far. When you learn how the owner likes things done, save it with the library tool (action memory_write).");
  parts.push(templates.length ? `Templates in the library (insert with the library tool, action template_insert):\n${templates.map((t) => `- ${t.id}: ${t.name}${t.description ? ` — ${t.description}` : ""} (${t.contents}, ${(t.lengthUs / 1e6).toFixed(1)} s)`).join("\n")}` : "The template library is empty.");
  if (recent.length) parts.push(`Earlier projects (most recent first):\n${recent.map((e) => `- ${e.name} (last opened ${e.lastOpened.slice(0, 10)})${e.note ? `: ${e.note}` : ""}`).join("\n")}`);
  return parts.join("\n\n");
}

/** Hermes profiles on this computer: the default one, plus each folder under profiles/. */
export async function hermesProfiles(): Promise<string[]> {
  const home = process.env.HERMES_HOME || (process.platform === "win32" ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "hermes") : path.join(os.homedir(), ".hermes"));
  try {
    const names = (await readdir(path.join(home, "profiles"), { withFileTypes: true })).filter((d) => d.isDirectory() && PROFILE_NAME.test(d.name)).map((d) => d.name);
    return names.sort();
  } catch {
    return [];
  }
}
