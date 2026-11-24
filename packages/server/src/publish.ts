import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { libraryDir } from "./library.js";

/**
 * What goes up with the video: title, description and thumbnail choices.
 *
 * Per project, in <project>/publish/: publish.json and thumbnails/.
 * Shared, in the app home's library/publish.json: the description template
 * (inline, or a file that is read fresh every time) and the thumbnail style
 * brief, so every video starts from the owner's own format.
 */
export interface Thumbnail {
  file: string;
  note: string;
  createdAt: string;
  by: "user" | "agent";
}

/** A picture the owner gave for this video's thumbnail: its look to borrow, or something to put in as it is. */
export interface ThumbRef {
  file: string;
  use: "theme" | "include";
}

export interface PublishData {
  /** What the owner wants on this video's thumbnail, in their words. */
  thumbInstructions: string;
  /** Reference pictures for this video's thumbnail, in publish/references/. */
  thumbRefs: ThumbRef[];
  title: string;
  /** Other title ideas to pick from. */
  titles: string[];
  description: string;
  thumbnails: Thumbnail[];
  /** File name of the picked thumbnail. */
  chosen?: string;
  updatedAt?: string;
}

export interface PublishSettings {
  /** The description format, written out. Used when no file is set or the file is missing. */
  descriptionTemplate: string;
  /** A file holding the description format, read fresh each time (so editing the file updates it). */
  descriptionTemplateFile: string;
  /** How thumbnails should look: layout, fonts, mascot, rules. */
  thumbnailStyle: string;
  /** Pictures the thumbnails build on (a mascot cutout, a logo), as absolute paths. */
  thumbnailRefs: string[];
  /** Shown in the feed preview. */
  channelName: string;
}

const EMPTY: PublishData = { thumbInstructions: "", thumbRefs: [], title: "", titles: [], description: "", thumbnails: [] };
const DEFAULT_SETTINGS: PublishSettings = { descriptionTemplate: "", descriptionTemplateFile: "", thumbnailStyle: "", thumbnailRefs: [], channelName: "" };
const IMAGE = /\.(png|jpe?g|webp)$/i;
const MAX_IMAGE = 25 * 1024 * 1024;

const pubDir = (projectDir: string) => path.join(projectDir, "publish");
export const thumbsDir = (projectDir: string) => path.join(pubDir(projectDir), "thumbnails");
export const refsDir = (projectDir: string) => path.join(pubDir(projectDir), "references");

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
  await rename(tmp, file);
}

const str = (v: unknown, max: number) => String(v ?? "").slice(0, max);

export async function readPublish(projectDir: string): Promise<PublishData> {
  const saved = await readJson<Partial<PublishData>>(path.join(pubDir(projectDir), "publish.json"), {});
  const data: PublishData = { ...EMPTY, ...saved, titles: saved.titles ?? [], thumbnails: saved.thumbnails ?? [], thumbRefs: Array.isArray(saved.thumbRefs) ? saved.thumbRefs : [], thumbInstructions: typeof saved.thumbInstructions === "string" ? saved.thumbInstructions : "" };
  const refs = existsSync(refsDir(projectDir)) ? await readdir(refsDir(projectDir)) : [];
  data.thumbRefs = data.thumbRefs.filter((r) => r && typeof r.file === "string" && refs.includes(r.file)).map((r) => ({ file: r.file, use: r.use === "include" ? "include" : "theme" }));
  // Pictures dropped straight into the folder count too; ones deleted from it do not.
  const dir = thumbsDir(projectDir);
  const files = existsSync(dir) ? (await readdir(dir)).filter((f) => IMAGE.test(f)) : [];
  data.thumbnails = data.thumbnails.filter((t) => files.includes(t.file));
  for (const f of files) {
    if (!data.thumbnails.some((t) => t.file === f)) {
      const s = await stat(path.join(dir, f));
      data.thumbnails.push({ file: f, note: "", createdAt: s.mtime.toISOString(), by: "user" });
    }
  }
  data.thumbnails.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (data.chosen && !files.includes(data.chosen)) delete data.chosen;
  return data;
}

export async function writePublish(projectDir: string, patch: Partial<Pick<PublishData, "title" | "titles" | "description" | "chosen" | "thumbInstructions" | "thumbRefs">>): Promise<PublishData> {
  const data = await readPublish(projectDir);
  if (patch.thumbInstructions !== undefined) data.thumbInstructions = str(patch.thumbInstructions, 3000);
  if (patch.thumbRefs !== undefined) {
    // Only how each picture is used, and their order, change here; pictures are added and removed on their own.
    if (!Array.isArray(patch.thumbRefs)) throw new Error("thumbRefs must be a list");
    const have = new Map(data.thumbRefs.map((r) => [r.file, r]));
    const next: ThumbRef[] = [];
    for (const r of patch.thumbRefs as Partial<ThumbRef>[]) {
      const hit = r && typeof r.file === "string" ? have.get(r.file) : undefined;
      if (!hit) continue;
      next.push({ file: hit.file, use: r.use === "include" ? "include" : "theme" });
      have.delete(hit.file);
    }
    data.thumbRefs = [...next, ...have.values()];
  }
  if (patch.title !== undefined) data.title = str(patch.title, 200).replace(/[\r\n]+/g, " ");
  if (patch.titles !== undefined) {
    if (!Array.isArray(patch.titles)) throw new Error("titles must be a list");
    data.titles = patch.titles.map((t) => str(t, 200).replace(/[\r\n]+/g, " ").trim()).filter(Boolean).slice(0, 20);
  }
  if (patch.description !== undefined) data.description = str(patch.description, 10_000);
  if (patch.chosen !== undefined) {
    if (patch.chosen && !data.thumbnails.some((t) => t.file === patch.chosen)) throw new Error(`No thumbnail "${patch.chosen}"`);
    if (patch.chosen) data.chosen = patch.chosen;
    else delete data.chosen;
  }
  data.updatedAt = new Date().toISOString();
  await writeJson(path.join(pubDir(projectDir), "publish.json"), data);
  return data;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

async function record(projectDir: string, file: string, note: string, by: "user" | "agent", choose: boolean): Promise<PublishData> {
  const data = await readPublish(projectDir);
  const hit = data.thumbnails.find((t) => t.file === file);
  // Just made: copies keep the original's file date, so the time is set here.
  if (hit) Object.assign(hit, { note, by, createdAt: new Date().toISOString() });
  if (choose || !data.chosen) data.chosen = file;
  data.updatedAt = new Date().toISOString();
  await writeJson(path.join(pubDir(projectDir), "publish.json"), data);
  return readPublish(projectDir);
}

/** Copies a picture into the project's thumbnails. The original is left where it is. */
export async function addThumbnail(projectDir: string, source: string, note: string, by: "user" | "agent", choose = false): Promise<{ file: string; data: PublishData }> {
  if (!path.isAbsolute(source)) throw new Error("path must be absolute");
  if (!IMAGE.test(source)) throw new Error("A thumbnail must be a .png, .jpg or .webp picture");
  const s = await stat(source).catch(() => null);
  if (!s?.isFile()) throw new Error(`No file at ${source}`);
  if (s.size > MAX_IMAGE) throw new Error("That picture is too big for a thumbnail (over 25 MB)");
  await mkdir(thumbsDir(projectDir), { recursive: true });
  const base = path.basename(source).replace(/[^\w.-]+/g, "-").slice(-60);
  const file = `${stamp()}-${base}`;
  await copyFile(source, path.join(thumbsDir(projectDir), file));
  return { file, data: await record(projectDir, file, str(note, 300), by, choose) };
}

export async function saveThumbnailBytes(projectDir: string, bytes: Buffer, ext: "jpg" | "png", note: string, by: "user" | "agent"): Promise<{ file: string; data: PublishData }> {
  await mkdir(thumbsDir(projectDir), { recursive: true });
  const file = `${stamp()}-frame.${ext}`;
  await writeFile(path.join(thumbsDir(projectDir), file), bytes);
  return { file, data: await record(projectDir, file, str(note, 300), by, false) };
}

export async function removeThumbnail(projectDir: string, file: string): Promise<PublishData> {
  if (!IMAGE.test(file) || file !== path.basename(file)) throw new Error(`No thumbnail "${file}"`);
  await rm(path.join(thumbsDir(projectDir), file), { force: true });
  return readPublish(projectDir);
}

/** Saves a reference picture for this video's thumbnail (pasted, dropped or picked). */
export async function addThumbRef(projectDir: string, bytes: Buffer, ext: string): Promise<{ file: string; data: PublishData }> {
  if (!/^(png|jpg|webp)$/.test(ext)) throw new Error("A reference must be a PNG, JPEG or WebP picture");
  if (!bytes.length) throw new Error("The picture is empty");
  if (bytes.length > MAX_IMAGE) throw new Error("That picture is too big (over 25 MB)");
  const data = await readPublish(projectDir);
  if (data.thumbRefs.length >= 8) throw new Error("Up to 8 reference pictures per video");
  await mkdir(refsDir(projectDir), { recursive: true });
  const file = `${stamp()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  await writeFile(path.join(refsDir(projectDir), file), bytes);
  data.thumbRefs.push({ file, use: "theme" });
  data.updatedAt = new Date().toISOString();
  await writeJson(path.join(pubDir(projectDir), "publish.json"), data);
  return { file, data: await readPublish(projectDir) };
}

export async function removeThumbRef(projectDir: string, file: string): Promise<PublishData> {
  if (!IMAGE.test(file) || file !== path.basename(file)) throw new Error(`No reference "${file}"`);
  await rm(path.join(refsDir(projectDir), file), { force: true });
  return readPublish(projectDir);
}

export function thumbRefPath(projectDir: string, file: string): string | null {
  if (!IMAGE.test(file) || file !== path.basename(file)) return null;
  const p = path.join(refsDir(projectDir), file);
  return existsSync(p) ? p : null;
}

export function thumbnailPath(projectDir: string, file: string): string | null {
  if (!IMAGE.test(file) || file !== path.basename(file)) return null;
  const p = path.join(thumbsDir(projectDir), file);
  return existsSync(p) ? p : null;
}

// ---------------------------------------------------------------- shared settings

export async function readPublishSettings(): Promise<PublishSettings> {
  const saved = await readJson<Partial<PublishSettings>>(path.join(libraryDir(), "publish.json"), {});
  return { ...DEFAULT_SETTINGS, ...saved, thumbnailRefs: Array.isArray(saved.thumbnailRefs) ? saved.thumbnailRefs.map(String) : [] };
}

export async function writePublishSettings(patch: Partial<PublishSettings>): Promise<PublishSettings> {
  const next = await readPublishSettings();
  if (patch.descriptionTemplate !== undefined) next.descriptionTemplate = str(patch.descriptionTemplate, 20_000);
  if (patch.descriptionTemplateFile !== undefined) next.descriptionTemplateFile = str(patch.descriptionTemplateFile, 500).trim();
  if (patch.thumbnailStyle !== undefined) next.thumbnailStyle = str(patch.thumbnailStyle, 10_000);
  if (patch.channelName !== undefined) next.channelName = str(patch.channelName, 100).trim();
  if (patch.thumbnailRefs !== undefined) {
    if (!Array.isArray(patch.thumbnailRefs)) throw new Error("thumbnailRefs must be a list of paths");
    next.thumbnailRefs = patch.thumbnailRefs.map((p) => str(p, 500).trim()).filter(Boolean).slice(0, 12);
  }
  await writeJson(path.join(libraryDir(), "publish.json"), next);
  return next;
}

/** The description format: the file when one is set and readable, else the written-out one. */
export async function descriptionTemplate(s: PublishSettings): Promise<{ text: string; from: string }> {
  if (s.descriptionTemplateFile) {
    try {
      return { text: await readFile(s.descriptionTemplateFile, "utf8"), from: s.descriptionTemplateFile };
    } catch {
      /* fall through to the written-out one */
    }
  }
  return { text: s.descriptionTemplate, from: s.descriptionTemplate ? "library" : "" };
}

// ---------------------------------------------------------------- timed outline

export function clockLabel(us: number): string {
  const total = Math.max(0, Math.floor(us / 1e6));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * What is said in the finished edit, in paragraphs of about `everyUs`, each
 * starting with its time in the finished video. Times are after cuts and speed
 * changes, so they can be used as chapter times as they are.
 */
export function timedOutline(cues: { startUs: number; endUs: number; text: string }[], everyUs = 30_000_000): string {
  const lines: string[] = [];
  let start = -1;
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) lines.push(`[${clockLabel(start)}] ${buf.join(" ")}`);
    buf = [];
  };
  for (const c of cues) {
    if (start < 0 || c.startUs - start >= everyUs) {
      flush();
      start = c.startUs;
    }
    buf.push(c.text.replace(/\s+/g, " ").trim());
  }
  flush();
  return lines.join("\n");
}
