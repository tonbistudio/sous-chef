import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { EditError, type Media } from "@sous-chef/core";

function run(cmd: string, args: string[], maxBuffer = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "buffer", maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${stderr.toString("utf8").trim().slice(-600) || err.message}`));
      else resolve(stdout);
    });
  });
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

function parseRate(rate: string | undefined): number | undefined {
  if (!rate) return undefined;
  const [n, d] = rate.split("/").map(Number);
  if (!n || !d) return undefined;
  return Math.round((n / d) * 1000) / 1000;
}

/** Reads what a media file is with ffprobe. */
export async function probeMedia(file: string): Promise<Omit<Media, "id">> {
  let info;
  try {
    info = await stat(file);
  } catch {
    throw new EditError("not_found", `File not found: ${file}`);
  }
  if (!info.isFile()) throw new EditError("invalid", `Not a file: ${file}`);
  const out = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  const data = JSON.parse(out.toString("utf8")) as {
    format?: { duration?: string };
    streams?: Array<Record<string, unknown>>;
  };
  const streams = data.streams ?? [];
  const isImage = IMAGE_EXT.has(path.extname(file).toLowerCase());
  const video = streams.find((s) => s.codec_type === "video" && (s.disposition as { attached_pic?: number })?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === "audio");
  if (!video && !audio) throw new EditError("invalid", `No video or audio found in ${file}`);
  const seconds = Number(data.format?.duration ?? 0);
  const kind: Media["kind"] = isImage ? "image" : video ? "video" : "audio";
  return {
    path: file.replace(/\\/g, "/"),
    kind,
    durationUs: kind === "image" ? 0 : Math.round(seconds * 1_000_000),
    probe: {
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
      ...(video
        ? {
            width: Number(video.width),
            height: Number(video.height),
            fps: parseRate(video.avg_frame_rate as string) ?? parseRate(video.r_frame_rate as string),
            videoCodec: String(video.codec_name),
          }
        : {}),
      ...(audio ? { audioCodec: String(audio.codec_name), audioChannels: Number(audio.channels) } : {}),
    },
    fingerprint: { size: info.size, mtimeMs: Math.round(info.mtimeMs) },
  };
}

/** One frame of a video as JPEG bytes. */
export async function grabFrame(file: string, us: number, width: number): Promise<Buffer> {
  const w = Math.max(64, Math.min(1920, Math.round(width)));
  const seconds = Math.max(0, us / 1_000_000).toFixed(6);
  const jpeg = await run("ffmpeg", [
    "-v", "error", "-ss", seconds, "-i", file, "-frames:v", "1",
    "-vf", `scale=${w}:-2`, "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "4", "pipe:1",
  ]);
  if (jpeg.length === 0) throw new EditError("invalid", "No frame at that time");
  return jpeg;
}

/**
 * A short piece of a take as a small file, for agents on another computer to watch or hear:
 * mp3 sound, or a 640-wide mp4 with sound. Cut from the given file (the proxy when there is one).
 */
export async function cutExcerpt(file: string, us: number, durUs: number, kind: "audio" | "video"): Promise<Buffer> {
  const ss = Math.max(0, us / 1_000_000).toFixed(3);
  const t = Math.max(0.5, durUs / 1_000_000).toFixed(3);
  const args =
    kind === "audio"
      ? ["-v", "error", "-ss", ss, "-t", t, "-i", file, "-vn", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "96k", "-f", "mp3", "pipe:1"]
      : ["-v", "error", "-ss", ss, "-t", t, "-i", file, "-vf", "scale=640:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"];
  const out = await run("ffmpeg", args, 150 * 1024 * 1024);
  if (out.length === 0) throw new EditError("invalid", "Nothing there to cut");
  return out;
}

const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska",
  ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".aac": "audio/aac", ".flac": "audio/flac", ".ogg": "audio/ogg", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
};

export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}
