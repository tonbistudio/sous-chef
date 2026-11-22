import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Transcript, Word } from "@sous-chef/core";

/**
 * Speech-to-text word times are approximate: a word's end is often marked
 * before its last sound has died away, and its start a little late. Cutting
 * on those times chops words. This moves each word's start and end to where
 * the sound really goes quiet, measured from the audio, without ever crossing
 * into a neighbouring word. The engine's own transcript file is left as it is;
 * the adjusted copy lives in the project's cache.
 */
const FRAME_S = 0.01;
const MAX_TAIL_US = 400_000;
const MAX_LEAD_US = 250_000;
/** Quiet must last this many frames to count as the end of a sound; a stop consonant is a short dip, not an end. */
const QUIET_RUN = 3;
/** Kept past the point where the sound fades, for soft endings ("s", "th", a trailing breath). */
const TAIL_MARGIN_US = 50_000;
const LEAD_MARGIN_US = 40_000;
/** Bump when the method changes, so cached results are worked out again. */
export const REFINE_VERSION = 2;

/** Loudness of every 10 ms of a 16-bit mono WAV file. */
export function frameLevels(wav: Buffer): { levels: Float32Array; rate: number } {
  let rate = 16000;
  let at = 12;
  let data = wav.subarray(44);
  while (at + 8 <= wav.length) {
    const id = wav.toString("ascii", at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === "fmt ") rate = wav.readUInt32LE(at + 12);
    if (id === "data") {
      data = wav.subarray(at + 8, Math.min(wav.length, at + 8 + size));
      break;
    }
    at += 8 + size + (size % 2);
  }
  const per = Math.round(rate * FRAME_S);
  const samples = Math.floor(data.length / 2);
  const levels = new Float32Array(Math.floor(samples / per));
  for (let f = 0; f < levels.length; f++) {
    let sum = 0;
    const base = f * per * 2;
    for (let i = 0; i < per; i++) {
      const v = data.readInt16LE(base + i * 2);
      sum += v * v;
    }
    levels[f] = Math.sqrt(sum / per);
  }
  return { levels, rate };
}

/** The level under which a frame counts as quiet: a little above the room noise. */
export function quietLevel(levels: Float32Array): number {
  if (!levels.length) return 0;
  const sorted = Float32Array.from(levels).sort();
  const floor = sorted[Math.floor(sorted.length * 0.1)]!;
  const speech = sorted[Math.floor(sorted.length * 0.9)]!;
  return Math.max(floor * 1.8, floor + (speech - floor) * 0.05, 30);
}

export function refineWords(words: Word[], levels: Float32Array): Word[] {
  const quiet = quietLevel(levels);
  const frame = (us: number) => Math.max(0, Math.min(levels.length - 1, Math.round(us / 1e6 / FRAME_S)));
  const us = (f: number) => Math.round(f * FRAME_S * 1e6);
  const isQuiet = (f: number) => levels[f]! < quiet;
  const out = words.map((w) => ({ ...w }));
  for (let i = 0; i < out.length; i++) {
    const w = out[i]!;
    const next = out[i + 1];
    // The end moves later until the sound has gone, but not into the next word.
    const endLimit = Math.min(w.endUs + MAX_TAIL_US, next ? Math.max(w.endUs, next.startUs) : w.endUs + MAX_TAIL_US);
    let f = frame(w.endUs);
    const fl = frame(endLimit);
    const quietFrom = (x: number) => {
      for (let k = 0; k < QUIET_RUN; k++) if (x + k < levels.length && !isQuiet(x + k)) return false;
      return true;
    };
    while (f < fl && !quietFrom(f)) f++;
    w.endUs = Math.max(w.endUs, Math.min(endLimit, us(f) + TAIL_MARGIN_US));
  }
  for (let i = 0; i < out.length; i++) {
    const w = out[i]!;
    const prev = out[i - 1];
    // The start moves earlier until it reaches quiet, but not into the word before.
    const startLimit = Math.max(w.startUs - MAX_LEAD_US, prev ? Math.min(w.startUs, prev.endUs) : 0, 0);
    let f = frame(w.startUs);
    const fl = frame(startLimit);
    const quietBefore = (x: number) => {
      for (let k = 1; k <= QUIET_RUN; k++) if (x - k >= 0 && !isQuiet(x - k)) return false;
      return true;
    };
    while (f > fl && !quietBefore(f)) f--;
    w.startUs = Math.min(w.startUs, Math.max(startLimit, us(f) - LEAD_MARGIN_US));
    if (w.endUs <= w.startUs) w.endUs = w.startUs + 1000;
  }
  return out;
}

/**
 * Speech-to-text often leaves out "um" and "uh". This finds short voiced
 * sounds in the gaps between words, loud enough to be the speaker rather
 * than the room, and adds each as an unsure "uh?" so it shows in the
 * transcript and the rough cut can offer to remove it.
 */
export function unheardFillers(words: Word[], levels: Float32Array): Word[] {
  if (!levels.length || words.length < 2) return [];
  const sorted = Float32Array.from(levels).sort();
  const speech = sorted[Math.floor(sorted.length * 0.9)]!;
  const quiet = quietLevel(levels);
  const loud = Math.max(quiet * 2, speech * 0.3);
  const out: Word[] = [];
  const frame = (us: number) => Math.max(0, Math.min(levels.length - 1, Math.round(us / 1e6 / FRAME_S)));
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i]!.endUs + 30_000;
    const b = words[i + 1]!.startUs - 30_000;
    if (b - a < 200_000) continue;
    let f = frame(a);
    const end = frame(b);
    while (f < end) {
      if (levels[f]! < quiet) {
        f++;
        continue;
      }
      let g = f;
      let peak = 0;
      let quietRun = 0;
      while (g < end && quietRun < QUIET_RUN) {
        if (levels[g]! < quiet) quietRun++;
        else quietRun = 0;
        peak = Math.max(peak, levels[g]!);
        g++;
      }
      const lenUs = (g - quietRun - f) * FRAME_S * 1e6;
      // An "um" is a sustained voiced sound: not a click (too short) and not a sentence (too long).
      if (lenUs >= 150_000 && lenUs <= 900_000 && peak >= loud) {
        const startUs = Math.round(f * FRAME_S * 1e6);
        out.push({ id: `f${Math.round(startUs / 1000)}`, text: "uh?", startUs, endUs: startUs + Math.round(lenUs), conf: 0.2, guessed: true });
      }
      f = g;
    }
  }
  return out;
}

/** The transcript with word times adjusted to the audio, from cache when it has been worked out. */
export async function refined(projectDir: string, mediaId: string, transcript: Transcript, source: string): Promise<Transcript> {
  const wav = path.join(projectDir, "cache", "audio", `${mediaId}.wav`);
  const cached = path.join(projectDir, "cache", "refined", `${mediaId}.v${REFINE_VERSION}.json`);
  try {
    if (existsSync(cached) && (await stat(cached)).mtimeMs >= (await stat(source)).mtimeMs) return JSON.parse(await readFile(cached, "utf8")) as Transcript;
    if (!existsSync(wav)) return transcript;
    const { levels } = frameLevels(await readFile(wav));
    const words = refineWords(transcript.words, levels);
    const fillers = unheardFillers(words, levels);
    const result: Transcript = { ...transcript, words: [...words, ...fillers].sort((x, y) => x.startUs - y.startUs) };
    await mkdir(path.dirname(cached), { recursive: true });
    await writeFile(cached, JSON.stringify(result), "utf8");
    return result;
  } catch {
    return transcript;
  }
}
