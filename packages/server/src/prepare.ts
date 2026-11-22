import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Media } from "@sous-chef/core";
import { hasNvenc } from "./export.js";
import type { JobHandle } from "./jobs.js";

/**
 * Everything derived from a take so the editor feels instant: a proxy that
 * seeks quickly, the sound's outline for the timeline, and a strip of small
 * pictures. All of it lives in the project's cache folder and can be deleted;
 * it is rebuilt on demand. The takes themselves are only ever read.
 */

export interface Prepared {
  proxy: boolean;
  wave: boolean;
  thumbs: { intervalUs: number; cols: number; rows: number; count: number; w: number; h: number } | null;
}

export const WAVE_PER_SECOND = 100;
const THUMB_W = 160;
const THUMB_H = 90;
const THUMB_COLS = 10;

export const proxyPath = (dir: string, id: string) => path.join(dir, "cache", "proxy", `${id}.mp4`);
export const wavePath = (dir: string, id: string) => path.join(dir, "cache", "wave", `${id}.json`);
export const thumbsPath = (dir: string, id: string) => path.join(dir, "cache", "thumbs", `${id}.jpg`);
const thumbsMeta = (dir: string, id: string) => path.join(dir, "cache", "thumbs", `${id}.json`);

export async function preparedState(dir: string, media: Media[]): Promise<Record<string, Prepared>> {
  const out: Record<string, Prepared> = {};
  for (const m of media) {
    let thumbs: Prepared["thumbs"] = null;
    if (existsSync(thumbsPath(dir, m.id))) {
      try {
        thumbs = JSON.parse(await readFile(thumbsMeta(dir, m.id), "utf8"));
      } catch {
        thumbs = null;
      }
    }
    out[m.id] = { proxy: existsSync(proxyPath(dir, m.id)), wave: existsSync(wavePath(dir, m.id)), thumbs };
  }
  return out;
}

/** What still needs building for a media file. */
export function missingFor(dir: string, m: Media): { proxy: boolean; wave: boolean; thumbs: boolean } {
  const video = m.kind === "video" && m.probe.hasVideo;
  return {
    proxy: video && !existsSync(proxyPath(dir, m.id)),
    wave: m.probe.hasAudio && !existsSync(wavePath(dir, m.id)),
    thumbs: video && !existsSync(thumbsPath(dir, m.id)),
  };
}

function ffmpeg(args: string[], handle: JobHandle, onProgressUs?: (us: number) => void, onData?: (chunk: Buffer) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-nostats", ...(onProgressUs ? ["-progress", "pipe:2"] : []), ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    handle.onCancel = () => child.kill();
    let err = "";
    child.stderr.on("data", (d: Buffer) => {
      const text = d.toString("utf8");
      if (onProgressUs) {
        const m = /out_time_us=(\d+)/g;
        let hit: RegExpExecArray | null;
        let last = -1;
        while ((hit = m.exec(text))) last = Number(hit[1]);
        if (last >= 0) onProgressUs(last);
      }
      err = (err + text).slice(-3000);
    });
    child.stdout.on("data", (d: Buffer) => onData?.(d));
    child.on("error", (e) => reject(new Error(`Could not run ffmpeg: ${e.message}`)));
    child.on("close", (code) => {
      if (handle.cancelled) reject(new Error("cancelled"));
      else if (code === 0) resolve();
      else reject(new Error(err.split(/\r?\n/).filter((l) => l && !/^[a-z_]+=/.test(l)).slice(-3).join(" | ") || `ffmpeg exited with ${code}`));
    });
  });
}

/** A copy of the take with a key frame every quarter second, so jumping across cuts is immediate. */
async function buildProxy(file: string, out: string, m: Media, handle: JobHandle, report: (p: number) => void): Promise<void> {
  await mkdir(path.dirname(out), { recursive: true });
  const tmp = out.replace(/\.mp4$/, ".part.mp4");
  const fps = m.probe.fps && m.probe.fps > 0 ? m.probe.fps : 60;
  const gop = String(Math.max(6, Math.round(fps / 4)));
  const video = (await hasNvenc())
    ? ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "27", "-b:v", "0", "-bf", "0"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-bf", "0"];
  await ffmpeg(
    ["-y", "-reinit_filter", "0", "-i", file, "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=-2:'min(1080,ih)'", ...video, "-g", gop, "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", tmp],
    handle,
    (us) => report(m.durationUs > 0 ? us / m.durationUs : 0),
  );
  await rm(out, { force: true });
  await rename(tmp, out);
}

/** The loudest level in every hundredth of a second, as one byte each. */
async function buildWave(file: string, out: string, handle: JobHandle): Promise<void> {
  await mkdir(path.dirname(out), { recursive: true });
  const rate = 8000;
  const per = rate / WAVE_PER_SECOND;
  const peaks: number[] = [];
  let carry: Buffer = Buffer.alloc(0);
  let max = 0;
  let n = 0;
  await ffmpeg(["-i", file, "-vn", "-ac", "1", "-ar", String(rate), "-f", "s16le", "pipe:1"], handle, undefined, (chunk) => {
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const usable = buf.length - (buf.length % 2);
    for (let i = 0; i < usable; i += 2) {
      const v = Math.abs(buf.readInt16LE(i));
      if (v > max) max = v;
      if (++n === per) {
        peaks.push(Math.min(255, Math.round(Math.sqrt(max / 32768) * 255)));
        max = 0;
        n = 0;
      }
    }
    carry = buf.subarray(usable);
  });
  if (n > 0) peaks.push(Math.min(255, Math.round(Math.sqrt(max / 32768) * 255)));
  await writeFile(out + ".tmp", JSON.stringify({ perSecond: WAVE_PER_SECOND, peaks: Buffer.from(peaks).toString("base64") }), "utf8");
  await rm(out, { force: true });
  await rename(out + ".tmp", out);
}

/** A sheet of small pictures spread across the take, for the timeline. Reads key frames only, so it is quick. */
async function buildThumbs(file: string, dir: string, m: Media, handle: JobHandle): Promise<void> {
  const out = thumbsPath(dir, m.id);
  await mkdir(path.dirname(out), { recursive: true });
  const seconds = Math.max(1, m.durationUs / 1e6);
  const interval = Math.max(2, Math.ceil(seconds / 240));
  const count = Math.max(1, Math.ceil(seconds / interval));
  const rows = Math.ceil(count / THUMB_COLS);
  const tmp = out.replace(/\.jpg$/, ".part.jpg");
  await ffmpeg(
    // -reinit_filter 0: a file whose format tags change part way (an earlier export, say) would restart
    // the tiling there and leave the rest of the sheet empty.
    ["-y", "-skip_frame", "nokey", "-reinit_filter", "0", "-i", file, "-an", "-vf", `fps=1/${interval},scale=${THUMB_W}:${THUMB_H},tile=${THUMB_COLS}x${rows}`, "-frames:v", "1", "-q:v", "5", tmp],
    handle,
  );
  await rm(out, { force: true });
  await rename(tmp, out);
  await writeFile(thumbsMeta(dir, m.id), JSON.stringify({ intervalUs: interval * 1e6, cols: THUMB_COLS, rows, count, w: THUMB_W, h: THUMB_H }), "utf8");
}

/** Builds whatever is missing for the given media. Quick things first, so the timeline fills in early. */
export async function prepareMedia(dir: string, items: { media: Media; file: string }[], handle: JobHandle, onPiece: () => void, onFailed: (mediaId: string) => void = () => {}): Promise<void> {
  const todo = items.map((i) => ({ ...i, need: missingFor(dir, i.media) }));
  // One file that cannot be read does not stop the others; the first problem is reported at the end.
  let first: unknown = null;
  const failed = (t: (typeof todo)[number], err: unknown) => {
    if (handle.cancelled) return;
    onFailed(t.media.id);
    first ??= err;
  };
  for (const t of todo) {
    if (handle.cancelled) return;
    if (t.need.wave) {
      handle.update(handle.job.progress, `Reading the sound of ${path.basename(t.file)}`);
      try {
        await buildWave(t.file, wavePath(dir, t.media.id), handle);
        onPiece();
      } catch (err) {
        failed(t, err);
        continue;
      }
    }
    if (t.need.thumbs) {
      handle.update(handle.job.progress, `Making pictures for ${path.basename(t.file)}`);
      await buildThumbs(t.file, dir, t.media, handle).then(onPiece, () => undefined);
    }
  }
  const proxies = todo.filter((t) => t.need.proxy);
  const total = proxies.reduce((s, t) => s + Math.max(1, t.media.durationUs), 0);
  let before = 0;
  for (const t of proxies) {
    if (handle.cancelled) return;
    const label = `Preparing smooth playback for ${path.basename(t.file)}`;
    try {
      await buildProxy(t.file, proxyPath(dir, t.media.id), t.media, handle, (p) => handle.update(0.05 + 0.95 * ((before + p * t.media.durationUs) / total), label));
      onPiece();
    } catch (err) {
      failed(t, err);
    }
    before += Math.max(1, t.media.durationUs);
  }
  if (first) throw first;
}
