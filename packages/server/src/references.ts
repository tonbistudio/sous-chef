import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { libraryDir } from "./library.js";
import { grabFrame, probeMedia } from "./media.js";

/**
 * Reference videos: other people's videos, or your own past ones, that you point Hermes at
 * ("cut it like this", "match this intro"). Only the path is kept; the file is never copied or moved.
 * A small thumbnail is cached in the library folder.
 */
export interface Reference {
  id: string;
  path: string;
  name: string;
  /** What it's a reference for, in your words. */
  note: string;
  addedAt: string;
  durationUs: number;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
}

export type ReferenceView = Reference & { missing: boolean };

const file = () => path.join(libraryDir(), "references.json");
const thumbsDir = () => path.join(libraryDir(), "reference-thumbs");
const ID = /^r[a-f0-9]{8}$/;
const THUMB_WIDTH = 480;

async function load(): Promise<Reference[]> {
  try {
    const list = JSON.parse(await readFile(file(), "utf8")) as unknown;
    return Array.isArray(list) ? (list as Reference[]) : [];
  } catch {
    return [];
  }
}

async function save(list: Reference[]): Promise<void> {
  await mkdir(libraryDir(), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(list, null, 2), "utf8");
  await rm(file(), { force: true }).catch(() => undefined);
  await rename(tmp, file());
}

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export async function listReferences(): Promise<ReferenceView[]> {
  return (await load()).map((r) => ({ ...r, missing: !existsSync(r.path) }));
}

export async function getReference(id: string): Promise<Reference> {
  const r = ID.test(id) ? (await load()).find((x) => x.id === id) : undefined;
  if (!r) throw new Error(`No reference "${id}"`);
  return r;
}

/** Adds a video by its path. Adding one that is already there updates its note instead. */
export async function addReference(filePath: string, note = "", name?: string): Promise<Reference> {
  const p = String(filePath ?? "").trim().replace(/^"(.*)"$/, "$1");
  if (!p || !path.isAbsolute(p)) throw new Error("Give the video's full path");
  const st = await stat(p).catch(() => null);
  if (!st?.isFile()) throw new Error(`No file at ${p}`);
  const list = await load();
  const had = list.find((r) => samePath(r.path, p));
  if (had) {
    if (note.trim()) had.note = note.trim().slice(0, 500);
    await save(list);
    return had;
  }
  const media = await probeMedia(p);
  if (media.kind !== "video" || !media.probe.hasVideo) throw new Error("That file isn't a video");
  const ref: Reference = {
    id: `r${randomBytes(4).toString("hex")}`,
    path: p,
    name: (name?.trim() || path.basename(p).replace(/\.[^.]+$/, "")).slice(0, 120),
    note: note.trim().slice(0, 500),
    addedAt: new Date().toISOString(),
    durationUs: media.durationUs,
    width: media.probe.width ?? null,
    height: media.probe.height ?? null,
    hasVideo: true,
  };
  await save([ref, ...list]);
  return ref;
}

export async function updateReference(id: string, patch: { note?: unknown; name?: unknown }): Promise<Reference> {
  const list = await load();
  const r = list.find((x) => x.id === id);
  if (!r) throw new Error(`No reference "${id}"`);
  if (typeof patch.note === "string") r.note = patch.note.trim().slice(0, 500);
  if (typeof patch.name === "string" && patch.name.trim()) r.name = patch.name.trim().slice(0, 120);
  await save(list);
  return r;
}

/** Forgets a reference. The video itself is left alone. */
export async function removeReference(id: string): Promise<void> {
  if (!ID.test(id)) throw new Error(`No reference "${id}"`);
  await save((await load()).filter((r) => r.id !== id));
  await rm(path.join(thumbsDir(), `${id}.jpg`), { force: true });
}

/** A frame a little way in (past any fade from black), cached. */
export async function referenceThumb(id: string): Promise<Buffer> {
  const r = await getReference(id);
  const cached = path.join(thumbsDir(), `${id}.jpg`);
  if (existsSync(cached)) return readFile(cached);
  if (!existsSync(r.path)) throw new Error("The video isn't at its path any more");
  const at = Math.min(Math.max(r.durationUs * 0.1, 0), Math.max(r.durationUs - 100_000, 0), 30_000_000);
  const jpeg = await grabFrame(r.path, Math.round(at), THUMB_WIDTH);
  await mkdir(thumbsDir(), { recursive: true });
  await writeFile(cached, jpeg);
  return jpeg;
}

/** One frame of a reference, for Hermes to look at. */
export async function referenceFrame(id: string, us: number, width = 960): Promise<Buffer> {
  const r = await getReference(id);
  if (!existsSync(r.path)) throw new Error("The video isn't at its path any more");
  const t = Math.max(0, Math.min(Math.round(us), Math.max(0, r.durationUs - 50_000)));
  return grabFrame(r.path, t, Math.max(160, Math.min(1920, Math.round(width))));
}

/** The references, in a few lines for Hermes at the start of a chat. */
export async function referencesBriefing(): Promise<string> {
  const list = await listReferences();
  if (!list.length) return "";
  const lines = list.slice(0, 30).map((r) => `- ${r.id}: "${r.name}" (${(r.durationUs / 1e6).toFixed(0)} s${r.width && r.height ? `, ${r.width}x${r.height}` : ""})${r.note ? ` — ${r.note}` : ""}${r.missing ? " [file missing]" : ""} at ${r.path.replace(/\\/g, "/")}`);
  return `Reference videos the owner keeps in the library, to point you at ("edit it like my reference", "match that intro"). They are files on this computer: study them however suits the question, with your own tools (ffprobe/ffmpeg for frames, scene changes, clips; your transcription for what is said and how fast) or the library tool's reference_frames for a quick look. Only read them: never change, move or delete a reference file, and put anything you make from one in your own scratch space.\n${lines.join("\n")}`;
}
