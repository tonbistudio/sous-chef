import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { cameraPieces, hasBurnIn, layerBoxes, movesOf, toAss, type CameraPiece, type Cue, type OverlaySpan, type Plan, type Segment, type Settings } from "@sous-chef/core";

/**
 * Export: turns a compiled plan into a finished video with ffmpeg.
 *
 * The video is rendered in parts of a few dozen pieces each and the parts are
 * joined, so every ffmpeg command stays small however long the edit is. Each
 * kept piece of a take is its own input, seeked straight to its start, so a
 * heavily cut video costs about as much as its final length.
 *
 * Inside a part, from the bottom up:
 *   1. the main track, with the zoom camera;
 *   2. fades to and from black on main clips;
 *   3. video and picture clips from the other tracks, placed and faded;
 *   4. HyperFrames overlays (already rendered with transparency);
 *   5. text overlays and captions.
 * Sound is the main track mixed with every other clip that has sound.
 */

export const PART_SIZE = 30;
const AUDIO_RATE = 48000;
const TAIL_PART_US = 120_000_000;
const MAX_INPUTS = 60;
/** Main clips longer than this render as a part of their own. */
const LONG_SEGMENT_US = 60_000_000;
/** Length of the crossfade where two pieces of sound meet at a cut. */
const XFADE_S = 0.024;

export type Encoder = "h264_nvenc" | "libx264";

export interface ExportOptions {
  encoder: Encoder;
  /** Lower is better quality and a bigger file. Default 21. */
  quality?: number;
}

/** Everything about an export that is not in the plan. */
export interface ExportExtras {
  encoder?: Encoder;
  /** Caption cues in timeline time; burned in when `captions` is given. */
  cues?: Cue[];
  captions?: Settings["captions"] | null;
  /** Bring the whole video to this loudness (LUFS). */
  normalizeLufs?: number | null;
  /** Rendered HyperFrames overlays, by overlay id. */
  overlayFiles?: Record<string, string>;
}

export interface ExportJob {
  id: string;
  projectId: string;
  revision: number;
  outPath: string;
  state: "running" | "done" | "failed" | "cancelled";
  /** 0..1 */
  progress: number;
  encoder: Encoder;
  durationUs: number;
  startedAt: number;
  finishedAt?: number;
  /** How many seconds of video are rendered per second of waiting. */
  speed?: number;
  sizeBytes?: number;
  error?: string;
  /** Loudness of the finished file in LUFS (integrated), as measured. */
  loudnessLufs?: number;
  /** The target it was levelled to, when levelling was on. */
  targetLufs?: number;
}

/** Integrated loudness from the summary ffmpeg's ebur128 filter prints at the end of its run. */
function integratedLufs(stderr: string): number | null {
  const m = /Summary:[\s\S]*?I:\s*(-?[\d.]+|-inf)\s*LUFS/.exec(stderr);
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) && v > -70 ? v : null;
}
const finite = (s: string | undefined) => (s !== undefined && Number.isFinite(Number(s)) ? Number(s) : null);

/** Transitions that overlap the two pictures, and the ffmpeg xfade that draws each. */
const BLENDS: Partial<Record<string, string>> = { dissolve: "fade", wipe: "wipeleft", slide: "slideleft", zoom: "zoomin" };

const secs = (us: number) => (us / 1_000_000).toFixed(6);
const n = (v: number) => (Math.abs(v) < 1e-12 ? "0" : v.toFixed(9).replace(/\.?0+$/, ""));

function videoArgs(o: ExportOptions, fps: number): string[] {
  const q = String(o.quality ?? 21);
  const gop = String(Math.round(fps * 2));
  return o.encoder === "h264_nvenc"
    ? ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", q, "-b:v", "0", "-g", gop, "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-crf", q, "-g", gop, "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];
}

/** A stretch of one segment's picture with one camera description. */
export interface VideoPiece {
  seg: Segment;
  tlStartUs: number;
  tlEndUs: number;
  srcInUs: number;
  srcOutUs: number;
  /** null when the camera is home for the whole piece: no camera work needed. */
  cam: CameraPiece | null;
}

/** Splits a segment's picture wherever the camera starts or stops moving, on frame boundaries. */
export function videoPieces(plan: Plan, seg: Segment): VideoPiece[] {
  const whole: VideoPiece = { seg, tlStartUs: seg.tlStartUs, tlEndUs: seg.tlEndUs, srcInUs: seg.srcInUs, srcOutUs: seg.srcOutUs, cam: null };
  if (!plan.camera.length) return [whole];
  const frame = 1_000_000 / plan.fps;
  const snap = (us: number) => Math.round(Math.round(us / frame) * frame);
  const out: VideoPiece[] = [];
  for (const p of cameraPieces(movesOf(plan), seg.tlStartUs, seg.tlEndUs)) {
    const b = p.endUs === seg.tlEndUs ? seg.tlEndUs : snap(p.endUs);
    const last = out[out.length - 1];
    // Whatever a dropped sliver left uncovered is taken up by this piece.
    const start = last ? last.tlEndUs : seg.tlStartUs;
    if (b - start < frame * 0.5) continue;
    const piece: VideoPiece = {
      seg,
      tlStartUs: start,
      tlEndUs: b,
      srcInUs: seg.srcInUs + Math.round((start - seg.tlStartUs) * seg.speed),
      srcOutUs: seg.srcInUs + Math.round((b - seg.tlStartUs) * seg.speed),
      cam: p.still ? null : p,
    };
    if (last && !last.cam && !piece.cam) {
      last.tlEndUs = piece.tlEndUs;
      last.srcOutUs = piece.srcOutUs;
    } else out.push(piece);
  }
  if (!out.length) return [whole];
  out[out.length - 1]!.tlEndUs = seg.tlEndUs;
  out[out.length - 1]!.srcOutUs = seg.srcOutUs;
  return out;
}

/**
 * The camera as an ffmpeg expression. It replays the piece's moves exactly as
 * cameraAt does (quintic ease, log-space scale, centre tied to scale, clamp)
 * and leaves cx in variable 0, cy in 1 and scale in 2. `in` is the frame number.
 */
export function cameraExpr(piece: VideoPiece, fps: number): string {
  const cam = piece.cam!;
  const parts = [`st(0,${n(cam.base.cx)})`, `st(1,${n(cam.base.cy)})`, `st(2,${n(cam.base.scale)})`];
  for (const m of cam.moves) {
    const start = (m.startUs - piece.tlStartUs) / 1_000_000;
    const dur = m.durUs / 1_000_000;
    // u: how far through the move; p: eased. The perspective filter counts frames from 1.
    parts.push(`st(3,clip(((in-1)/${n(fps)}-(${n(start)}))/${n(dur)},0,1))`);
    parts.push(`st(4,ld(3)*ld(3)*ld(3)*(ld(3)*(6*ld(3)-15)+10))`);
    const bs = n(m.target.scale);
    // New scale, then the centre weight that keeps the move heading straight at the target.
    parts.push(`st(5,ld(2)*pow(${bs}/ld(2),ld(4)))`);
    parts.push(`st(6,if(lt(abs(log(${bs}/ld(2))),0.000001),ld(4),(1-ld(2)/ld(5))/(1-ld(2)/${bs})))`);
    parts.push(`st(0,ld(0)+(${n(m.target.cx)}-ld(0))*ld(6))`);
    parts.push(`st(1,ld(1)+(${n(m.target.cy)}-ld(1))*ld(6))`);
    parts.push(`st(2,if(lt(abs(log(${bs}/ld(2))),0.000001),ld(2),ld(5)))`);
  }
  // Keep the view inside the picture.
  parts.push(`st(7,0.5/ld(2))`, `st(0,clip(ld(0),ld(7),1-ld(7)))`, `st(1,clip(ld(1),ld(7),1-ld(7)))`);
  return parts.join(";");
}

/** The filter that shows the camera's view of a piece, sampled between pixels so slow moves do not shimmer. */
export function cameraFilter(piece: VideoPiece, fps: number): string {
  const c = cameraExpr(piece, fps);
  const x = (sign: string) => `'${c};(ld(0)${sign}ld(7))*W'`;
  const y = (sign: string) => `'${c};(ld(1)${sign}ld(7))*H'`;
  return `perspective=x0=${x("-")}:y0=${y("-")}:x1=${x("+")}:y1=${y("-")}:x2=${x("-")}:y2=${y("+")}:x3=${x("+")}:y3=${y("+")}:sense=source:interpolation=cubic:eval=frame`;
}

/** The scale-and-crop filter and position for a main clip that is not shown full frame, or null when it is. */
export function mainFrame(seg: Segment, W: number, H: number): { filter: string; x: number; y: number } | null {
  const t = seg.transform;
  if (!t) return null;
  const plain = Math.abs(t.x) < 1e-4 && Math.abs(t.y) < 1e-4 && Math.abs(t.scale - 1) < 1e-4 && t.crop[0] < 1e-4 && t.crop[1] < 1e-4 && t.crop[2] > 0.9999 && t.crop[3] > 0.9999;
  if (plain) return null;
  const { full, visible } = layerBoxes(t, seg.aspect, W / H);
  const fw = Math.max(2, Math.round((full[2] * W) / 2) * 2);
  const fh = Math.max(2, Math.round((full[3] * H) / 2) * 2);
  const [cx, cy, cw, ch] = t.crop;
  const cropped = cw < 0.999 || ch < 0.999 || cx > 0.001 || cy > 0.001;
  const crop = cropped ? `,crop=${Math.max(2, Math.round(fw * cw))}:${Math.max(2, Math.round(fh * ch))}:${Math.round(fw * cx)}:${Math.round(fh * cy)}` : "";
  return { filter: `scale=${fw}:${fh}:flags=bicubic,setsar=1${crop}`, x: Math.round(visible[0] * W), y: Math.round(visible[1] * H) };
}

/** atempo takes 0.5 to 100 per step; slower than half speed needs two steps. */
function tempo(speed: number): string {
  if (speed === 1) return "";
  const steps: number[] = [];
  let s = speed;
  while (s < 0.5) {
    steps.push(0.5);
    s /= 0.5;
  }
  steps.push(s);
  return steps.map((v) => `,atempo=${n(v)}`).join("");
}

/** One part of the video: a stretch of the timeline and the main-track segments in it. */
export interface Part {
  startUs: number;
  endUs: number;
  main: Segment[];
}

export function partsOf(plan: Plan): Part[] {
  const main = plan.segments.filter((s) => s.trackKind === "main").sort((a, b) => a.tlStartUs - b.tlStartUs);
  const parts: Part[] = [];
  // A part ends at PART_SIZE segments or MAX_INPUTS ffmpeg inputs, whichever comes first:
  // zooms split a segment into several inputs, and Windows limits how long a command can be.
  let chunk: Segment[] = [];
  let inputs = 0;
  // Clips on other tracks and HyperFrames overlays open inputs too: each counts once, in the first
  // part it overlaps, so a stretch busy with pictures and music is split sooner.
  const extra: { id: string; startUs: number; endUs: number }[] = [
    ...plan.segments.filter((s) => s.trackKind !== "main").map((s) => ({ id: `s:${s.clipId}:${s.srcInUs}`, startUs: s.tlStartUs, endUs: s.tlEndUs })),
    ...plan.overlays.filter((o) => o.kind === "hyperframes").map((o) => ({ id: `o:${o.id}`, startUs: o.tlStartUs, endUs: o.tlEndUs })),
  ];
  let counted = new Set<string>();
  const extraFor = (seg: Segment, from: Set<string>): string[] =>
    extra.filter((e) => e.endUs > seg.tlStartUs && e.startUs < seg.tlEndUs && !from.has(e.id)).map((e) => e.id);
  // Parts follow one another with nothing between: empty space before a part's first clip belongs to that part.
  let edge = 0;
  const close = () => {
    if (chunk.length) {
      const end = chunk[chunk.length - 1]!.tlEndUs;
      parts.push({ startUs: edge, endUs: end, main: chunk });
      edge = end;
    }
    chunk = [];
    inputs = 0;
    counted = new Set<string>();
  };
  // A long clip gets a part of its own. ffmpeg opens every input of a part at once; one that waits
  // behind other clips and then plays for minutes can stall the whole render (seen with ffmpeg 8).
  const long = (s: Segment) => s.tlEndUs - s.tlStartUs > LONG_SEGMENT_US;
  for (const seg of main) {
    const own = videoPieces(plan, seg).length + 1;
    const prev = chunk[chunk.length - 1];
    // A transition needs both sides in one part, so only the input limit may split there.
    const keep = Boolean(seg.transitionIn && prev && Math.abs(prev.tlEndUs - seg.tlStartUs) < 1000);
    const full = inputs + own + extraFor(seg, counted).length > MAX_INPUTS;
    if (chunk.length && (full || (!keep && (chunk.length >= PART_SIZE || long(seg) || (prev && long(prev)))))) close();
    const more = extraFor(seg, counted);
    for (const id of more) counted.add(id);
    chunk.push(seg);
    inputs += own + more.length;
  }
  close();
  // Other tracks may run on after the main track ends; that stretch plays over black.
  const frame = 1_000_000 / plan.fps;
  let t = parts.length ? parts[parts.length - 1]!.endUs : 0;
  while (plan.durationUs - t > frame) {
    const end = Math.min(plan.durationUs, t + TAIL_PART_US);
    parts.push({ startUs: t, endUs: end, main: [] });
    t = end;
  }
  return parts;
}

/**
 * The ffmpeg arguments that render one part into one file. Parts keep
 * uncompressed sound so joining them cannot add a gap or a click. `burn` is
 * the name of a subtitle file in the working folder, if this part has
 * captions or text.
 */
export function partArgs(plan: Plan, part: Part, mediaPath: (mediaId: string) => string, out: string, o: ExportOptions, extras: ExportExtras = {}, burn: string | null = null): string[] {
  const args: string[] = ["-hide_banner", "-y", "-nostats", "-progress", "pipe:1"];
  const filters: string[] = [];
  const { width: W, height: H, fps } = plan;
  const w0 = part.startUs;
  const lenS = (part.endUs - part.startUs) / 1_000_000;
  const local = (us: number) => (us - w0) / 1_000_000;
  const fadeS = Math.min(plan.audioFadeUs, 50_000) / 1_000_000;
  // The whole main track in order, to see what lies just beyond this part's edges.
  const allMain = plan.segments.filter((s) => s.trackKind === "main").sort((a, b) => a.tlStartUs - b.tlStartUs);
  const shape = `aresample=${AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;
  let inputs = 0;
  const input = (...pre: string[]): number => {
    args.push(...pre);
    return inputs++;
  };
  // Seeking before the input is fast and, because we re-encode, exact to the frame.
  const clipInput = (file: string, srcInUs: number, srcOutUs: number) => input("-reinit_filter", "0", "-ss", secs(srcInUs), "-t", secs(srcOutUs - srcInUs), "-i", file);
  // -reinit_filter 0: a file whose colour tags change part way (an earlier export, a spliced recording) must not
  // restart the filters mid-clip; that resets their clocks and the rest of the clip is lost (a freeze and silence).

  // ---- 1. the main track
  const vLabels: string[] = [];
  /** The sound, in play order: each piece, and whether it crossfades into the one before. */
  const aPieces: { label: string; join: boolean }[] = [];
  const silence = (label: string, s: number) => {
    filters.push(`anullsrc=r=${AUDIO_RATE}:cl=stereo,atrim=duration=${n(s)},${shape}[${label}]`);
    aPieces.push({ label: `[${label}]`, join: false });
  };
  /** Length in seconds of each picture label, so a blend knows where its overlap starts. */
  const vLens: number[] = [];
  /** Half a blend in timeline seconds, for the transition coming into part.main[i] (0 when none). */
  const blendHalf = (i: number): number => {
    const seg = part.main[i];
    const prev = part.main[i - 1];
    const t = seg?.transitionIn;
    if (!seg || !prev || !t || !BLENDS[t.kind] || Math.abs(prev.tlEndUs - seg.tlStartUs) > 1000) return 0;
    const h = t.durationUs / 2;
    // Both pictures next to the cut (pieces, where zooms split a clip) must be at least half a blend long.
    const a = videoPieces(plan, prev);
    const b = videoPieces(plan, seg);
    const lastA = a[a.length - 1]!;
    const firstB = b[0]!;
    if (lastA.tlEndUs - lastA.tlStartUs < h || firstB.tlEndUs - firstB.tlStartUs < h) return 0;
    return h / 1e6;
  };
  let cursor = part.startUs;
  part.main.forEach((seg, i) => {
    // Empty space on the main track plays as black and silence.
    const gapS = (seg.tlStartUs - cursor) / 1_000_000;
    if (gapS > 0.5 / fps) {
      filters.push(`color=black:s=${W}x${H}:r=${fps}:d=${gapS.toFixed(6)},format=yuv420p,setsar=1,trim=duration=${gapS.toFixed(6)}[g${i}]`);
      vLabels.push(`[g${i}]`);
      vLens.push(gapS);
      silence(`ga${i}`, gapS);
    }
    cursor = seg.tlEndUs;
    const pieces = videoPieces(plan, seg);
    const outDurS = (seg.tlEndUs - seg.tlStartUs) / 1_000_000;
    const speed = seg.speed === 1 ? "" : `,setpts=PTS/${n(seg.speed)}`;
    const audioInput = -1;
    // A blend overlaps the two sides: this clip's picture starts half a blend early and the one before
    // runs half a blend late (the same way the sound crossfades), so the edit keeps its length.
    const hIn = blendHalf(i);
    const hOut = blendHalf(i + 1);
    pieces.forEach((piece, k) => {
      const preS = k === 0 ? hIn : 0;
      const postS = k === pieces.length - 1 ? hOut : 0;
      const wantIn = piece.srcInUs - Math.round(preS * 1e6 * seg.speed);
      const inUs = Math.max(0, wantIn);
      const idx = clipInput(mediaPath(seg.mediaId), inUs, piece.srcOutUs + Math.round(postS * 1e6 * seg.speed));
      const durS = (piece.tlEndUs - piece.tlStartUs) / 1_000_000 + preS + postS;
      // Not enough of the take before the cut (its very start): the first frame is held.
      const short = (inUs - wantIn) / 1e6 / seg.speed;
      const hold = short > 0.0005 ? `,tpad=start_mode=clone:start_duration=${n(short)}` : "";
      // Running past the end of the take: the last frame is held.
      const tail = postS > 0 ? `,tpad=stop_mode=clone:stop_duration=${n(postS)}` : "";
      const camPiece = preS || postS ? { ...piece, tlStartUs: piece.tlStartUs - Math.round(preS * 1e6), tlEndUs: piece.tlEndUs + Math.round(postS * 1e6) } : piece;
      const camera = piece.cam ? `,${cameraFilter(camPiece, fps)}` : "";
      const framed = mainFrame(seg, W, H);
      if (framed) {
        // Moved, resized or cropped: draw the picture on black where it sits, then the camera moves over the whole frame.
        filters.push(`color=black:s=${W}x${H}:r=${fps}:d=${durS.toFixed(6)},format=yuv420p,setsar=1[bg${i}_${k}]`);
        filters.push(`[${idx}:v:0]setpts=PTS-STARTPTS${speed},fps=${fps}${hold}${tail},${framed.filter}[fg${i}_${k}]`);
        filters.push(
          `[bg${i}_${k}][fg${i}_${k}]overlay=x=${framed.x}:y=${framed.y}:shortest=1:format=auto,setsar=1${camera},format=yuv420p,trim=duration=${durS.toFixed(6)}[v${i}_${k}]`,
        );
      } else {
        filters.push(
          `[${idx}:v:0]setpts=PTS-STARTPTS${speed},fps=${fps}${hold}${tail},scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
            `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1${camera},format=yuv420p,trim=duration=${durS.toFixed(6)}[v${i}_${k}]`,
        );
      }
      if (k === 0 && hIn > 0 && vLabels.length) {
        // Blend into the picture before: the overlap is the last 2h of what came before.
        const before = vLabels.pop()!;
        const beforeLen = vLens.pop()!;
        const label = `[x${i}]`;
        filters.push(`${before}[v${i}_${k}]xfade=transition=${BLENDS[seg.transitionIn!.kind]}:duration=${n(hIn * 2)}:offset=${n(beforeLen - hIn * 2)}${label}`);
        vLabels.push(label);
        vLens.push(beforeLen + durS - hIn * 2);
      } else {
        vLabels.push(`[v${i}_${k}]`);
        vLens.push(durS);
      }
    });
    void audioInput;
    if (seg.hasAudio && !seg.muted) {
      // Where two pieces meet, the sound crossfades: each runs half the crossfade past the cut and the
      // two are joined with acrossfade, so the room tone carries straight through. Elsewhere (a clip
      // edge, a gap) a short fade stops clicks. Pieces are joined one after another, so ffmpeg reads the
      // sources in order like the picture, instead of all at once.
      const audible = (s: Segment | undefined) => Boolean(s && s.hasAudio && !s.muted);
      const prev = part.main[i - 1];
      const next = part.main[i + 1];
      const joinIn = audible(prev) && Math.abs(prev!.tlEndUs - seg.tlStartUs) < 1000 && outDurS > XFADE_S * 2 && (prev!.tlEndUs - prev!.tlStartUs) / 1e6 > XFADE_S * 2;
      const joinOut = audible(next) && Math.abs(next!.tlStartUs - seg.tlEndUs) < 1000 && outDurS > XFADE_S * 2 && (next!.tlEndUs - next!.tlStartUs) / 1e6 > XFADE_S * 2;
      const h = XFADE_S / 2;
      const preUs = joinIn ? Math.round(h * 1e6 * seg.speed) : 0;
      const postUs = joinOut ? Math.round(h * 1e6 * seg.speed) : 0;
      const inUs = Math.max(0, seg.srcInUs - preUs);
      // Short of source before the cut (the very start of a take): the missing bit is silence.
      const lead = (preUs - (seg.srcInUs - inUs)) / 1e6 / seg.speed;
      const total = outDurS + (joinIn ? h : 0) + (joinOut ? h : 0);
      const idx = clipInput(mediaPath(seg.mediaId), inUs, seg.srcOutUs + postUs);
      const gain = seg.volumeDb ? `,volume=${n(seg.volumeDb)}dB` : "";
      // Across a part boundary there is no crossfade (parts are joined sample for sample). Where the sound
      // simply carries on (same take, no cut between) a fade on each side would dip it, so there is none.
      const g = allMain.indexOf(seg);
      const carriesOn = (a: Segment | undefined, b: Segment | undefined) =>
        Boolean(a && b && audible(a) && audible(b) && a.mediaId === b.mediaId && a.speed === b.speed &&
          Math.abs(a.tlEndUs - b.tlStartUs) < 1000 && Math.abs(a.srcOutUs - b.srcInUs) < 1000);
      const seamIn = !prev && carriesOn(allMain[g - 1], seg);
      const seamOut = !next && carriesOn(seg, allMain[g + 1]);
      let fades = "";
      if (!joinIn && !seamIn && fadeS > 0 && outDurS > fadeS * 2) fades += `,afade=t=in:d=${fadeS}`;
      if (!joinOut && !seamOut && fadeS > 0 && outDurS > fadeS * 2) fades += `,afade=t=out:st=${n(total - fadeS)}:d=${fadeS}`;
      const pad = lead > 0.0005 ? `,adelay=${Math.round(lead * AUDIO_RATE)}S:all=1` : "";
      filters.push(`[${idx}:a:0]asetpts=PTS-STARTPTS${tempo(seg.speed)},${shape}${gain}${pad},apad,atrim=duration=${n(total)}${fades}[a${i}]`);
      aPieces.push({ label: `[a${i}]`, join: joinIn });
    } else {
      silence(`as${i}`, outDurS);
    }
  });
  if (vLabels.length) {
    filters.push(`${vLabels.join("")}concat=n=${vLabels.length}:v=1:a=0[base]`);
    // Crossfade each run of joined pieces, then lay the runs end to end, padded to the part's length.
    const runs: string[] = [];
    let x = 0;
    for (const p of aPieces) {
      if (p.join && runs.length) {
        const label = `[ax${x++}]`;
        filters.push(`${runs.pop()}${p.label}acrossfade=d=${n(XFADE_S)}:c1=qsin:c2=qsin${label}`);
        runs.push(label);
      } else runs.push(p.label);
    }
    filters.push(runs.length
      ? `${runs.join("")}concat=n=${runs.length}:v=0:a=1,apad,atrim=duration=${lenS.toFixed(6)}[amain0]`
      : `anullsrc=r=${AUDIO_RATE}:cl=stereo,atrim=duration=${lenS.toFixed(6)},${shape}[amain0]`);
  } else {
    filters.push(`color=black:s=${W}x${H}:r=${fps}:d=${lenS.toFixed(6)},format=yuv420p[base]`);
    filters.push(`anullsrc=r=${AUDIO_RATE}:cl=stereo,atrim=duration=${lenS.toFixed(6)},${shape}[amain0]`);
  }

  // ---- 2. fades to and from black on main clips (picture and sound)
  let top = "base";
  let layer = 0;
  const overlay = (label: string, x: string, y: string, fromS: number, toS: number) => {
    const next = `c${layer++}`;
    filters.push(`[${top}][${label}]overlay=x=${x}:y=${y}:enable='between(t,${n(fromS)},${n(toS)})':eof_action=pass:format=auto[${next}]`);
    top = next;
  };
  const gains: string[] = [];
  const seenClips = new Set<string>();
  for (const seg of part.main) {
    if (seenClips.has(seg.clipId)) continue;
    seenClips.add(seg.clipId);
    const black = (fromUs: number, durUs: number, out: boolean) => {
      // Only when the whole fade is inside this part; a fade split across parts is skipped.
      if (durUs < 20_000 || fromUs < part.startUs - 1 || fromUs + durUs > part.endUs + 1) return;
      const d = durUs / 1_000_000;
      const t = local(fromUs);
      const label = `k${layer}`;
      filters.push(`color=black:s=${W}x${H}:r=${fps}:d=${d.toFixed(6)},format=rgba,fade=t=${out ? "in" : "out"}:st=0:d=${d.toFixed(6)}:alpha=1,setpts=PTS+${n(t)}/TB[${label}]`);
      overlay(label, "0", "0", t, t + d);
      gains.push(out ? `if(between(t,${n(t)},${n(t + d)}),1-(t-${n(t)})/${n(d)},1)` : `if(between(t,${n(t)},${n(t + d)}),(t-${n(t)})/${n(d)},1)`);
    };
    black(seg.clipStartUs, seg.fadeInUs, false);
    black(seg.clipEndUs - seg.fadeOutUs, seg.fadeOutUs, true);
  }
  // Dips through a colour at a cut: the colour rises over the first half and clears over the second.
  for (const seg of part.main) {
    const t = seg.transitionIn;
    if (!t || (t.kind !== "white" && t.kind !== "black")) continue;
    const h = t.durationUs / 2;
    if (seg.tlStartUs - h < part.startUs - 1 || seg.tlStartUs + h > part.endUs + 1) continue;
    const d = h / 1e6;
    const at = local(seg.tlStartUs - h);
    const label = `d${layer}`;
    filters.push(
      `color=${t.kind}:s=${W}x${H}:r=${fps}:d=${n(d * 2)},format=rgba,fade=t=in:st=0:d=${n(d)}:alpha=1,fade=t=out:st=${n(d)}:d=${n(d)}:alpha=1,setpts=PTS+${n(at)}/TB[${label}]`,
    );
    overlay(label, "0", "0", at, at + d * 2);
  }
  let amain = "amain0";
  if (gains.length) {
    filters.push(`[amain0]volume=eval=frame:volume='${gains.join("*")}'[amain1]`);
    amain = "amain1";
  }

  // ---- 3 and 4. clips on other tracks, then HyperFrames overlays
  const mix: string[] = [];
  const others = plan.segments.filter((s) => s.trackKind !== "main" && s.tlEndUs > part.startUs && s.tlStartUs < part.endUs);
  /** Fades as filters on a layer whose time already runs in part time. */
  const alphaFades = (startUs: number, endUs: number, fadeInUs: number, fadeOutUs: number): string => {
    let f = "";
    if (fadeInUs >= 20_000 && startUs >= part.startUs) f += `,fade=t=in:st=${n(local(startUs))}:d=${n(fadeInUs / 1e6)}:alpha=1`;
    if (fadeOutUs >= 20_000 && endUs <= part.endUs) f += `,fade=t=out:st=${n(local(endUs - fadeOutUs))}:d=${n(fadeOutUs / 1e6)}:alpha=1`;
    return f;
  };
  const place = (t: Segment["transform"], aspect?: number) => {
    // Fit the whole source in its box, then trim the cropped edges off: what is left stays where it was.
    const { full, visible } = layerBoxes(t, aspect, W / H);
    const fw = Math.max(2, Math.round((full[2] * W) / 2) * 2);
    const fh = Math.max(2, Math.round((full[3] * H) / 2) * 2);
    const [cx, cy, cw, ch] = t.crop;
    const cropped = cw < 0.999 || ch < 0.999 || cx > 0.001 || cy > 0.001;
    const crop = cropped ? `,crop=${Math.max(2, Math.round(fw * cw))}:${Math.max(2, Math.round(fh * ch))}:${Math.round(fw * cx)}:${Math.round(fh * cy)}` : "";
    const alpha = t.opacity < 0.995 ? `,colorchannelmixer=aa=${n(Math.max(0, t.opacity))}` : "";
    return {
      filter: `scale=${fw}:${fh}:flags=bicubic,setsar=1${crop},format=rgba${alpha}`,
      x: String(Math.round(visible[0] * W)),
      y: String(Math.round(visible[1] * H)),
    };
  };
  for (const seg of others) {
    const a = Math.max(seg.tlStartUs, part.startUs);
    const b = Math.min(seg.tlEndUs, part.endUs);
    if (b - a < 1000) continue;
    const srcIn = seg.srcInUs + Math.round((a - seg.tlStartUs) * seg.speed);
    const srcOut = seg.srcInUs + Math.round((b - seg.tlStartUs) * seg.speed);
    const durS = (b - a) / 1_000_000;
    let idx = -1;
    if (seg.hasVideo) {
      idx = seg.still ? input("-loop", "1", "-framerate", String(fps), "-t", durS.toFixed(6), "-i", mediaPath(seg.mediaId)) : clipInput(mediaPath(seg.mediaId), srcIn, srcOut);
      const p = place(seg.transform, seg.aspect);
      const speed = seg.still || seg.speed === 1 ? "" : `,setpts=PTS/${n(seg.speed)}`;
      const label = `l${layer}`;
      filters.push(
        `[${idx}:v:0]setpts=PTS-STARTPTS${speed},fps=${fps},${p.filter},trim=duration=${durS.toFixed(6)},setpts=PTS+${n(local(a))}/TB` +
          `${alphaFades(seg.clipStartUs, seg.clipEndUs, seg.fadeInUs, seg.fadeOutUs)}[${label}]`,
      );
      overlay(label, p.x, p.y, local(a), local(b));
    }
    if (seg.hasAudio && !seg.muted && !seg.still) {
      if (idx < 0) idx = clipInput(mediaPath(seg.mediaId), srcIn, srcOut);
      const gain = seg.volumeDb ? `,volume=${n(seg.volumeDb)}dB` : "";
      let fades = "";
      // Clip fades when they fall in this part; otherwise the short anti-click fade.
      const inS = seg.fadeInUs >= 20_000 && seg.clipStartUs >= part.startUs && a === seg.clipStartUs ? seg.fadeInUs / 1e6 : fadeS;
      const outS = seg.fadeOutUs >= 20_000 && seg.clipEndUs <= part.endUs && b === seg.clipEndUs ? seg.fadeOutUs / 1e6 : fadeS;
      if (inS > 0 && durS > inS) fades += `,afade=t=in:d=${n(inS)}`;
      if (outS > 0 && durS > outS) fades += `,afade=t=out:st=${n(durS - outS)}:d=${n(outS)}`;
      const label = `m${mix.length}`;
      filters.push(`[${idx}:a:0]asetpts=PTS-STARTPTS${tempo(seg.speed)},${shape}${gain}${fades},atrim=duration=${durS.toFixed(6)},adelay=${Math.round(local(a) * 1000)}:all=1[${label}]`);
      mix.push(`[${label}]`);
    }
  }
  for (const o of plan.overlays) {
    const file = extras.overlayFiles?.[o.id];
    if (o.kind !== "hyperframes" || !file) continue;
    const a = Math.max(o.tlStartUs, part.startUs);
    const b = Math.min(o.tlEndUs, part.endUs);
    if (b - a < 1000) continue;
    const durS = (b - a) / 1_000_000;
    // The decoder has to be named for the transparency in a VP9 file to be read.
    const idx = input("-c:v", "libvpx-vp9", "-ss", secs(a - o.tlStartUs), "-t", durS.toFixed(6), "-i", file);
    const p = place(o.transform);
    const label = `h${layer}`;
    filters.push(`[${idx}:v:0]setpts=PTS-STARTPTS,fps=${fps},${p.filter},trim=duration=${durS.toFixed(6)},setpts=PTS+${n(local(a))}/TB${alphaFades(o.tlStartUs, o.tlEndUs, o.fadeInUs, o.fadeOutUs)}[${label}]`);
    overlay(label, p.x, p.y, local(a), local(b));
  }

  // ---- 5. text and captions
  if (burn) {
    filters.push(`[${top}]ass=${burn}[burned]`);
    top = "burned";
  }
  filters.push(`[${top}]format=yuv420p[v]`);
  if (mix.length) filters.push(`[${amain}]${mix.join("")}amix=inputs=${mix.length + 1}:normalize=0:duration=first:dropout_transition=0[a]`);
  else filters.push(`[${amain}]anull[a]`);

  args.push("-filter_complex", filters.join(";"), "-map", "[v]", "-map", "[a]", ...videoArgs(o, fps), "-c:a", "pcm_s16le", "-r", String(fps), "-t", lenS.toFixed(6), out);
  return args;
}

/** Ends an ffmpeg run outright: a stuck one can ignore a polite stop. On Windows, with anything it started. */
function stopHard(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill("SIGKILL"));
  else child.kill("SIGKILL");
}

/** Runs ffmpeg, reporting how many microseconds of output exist so far. */
function runFfmpeg(args: string[], onTime: (us: number) => void, track: (child: ChildProcess, running: boolean) => void, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], cwd });
    track(child, true);
    let err = "";
    child.stderr.on("data", (d: Buffer) => {
      err = (err + d.toString("utf8")).slice(-4000);
    });
    child.stdout.on("data", (d: Buffer) => {
      const m = /out_time_us=(\d+)/g;
      let hit: RegExpExecArray | null;
      let last = -1;
      while ((hit = m.exec(d.toString("utf8")))) last = Number(hit[1]);
      if (last >= 0) onTime(last);
    });
    child.on("error", (e) => {
      track(child, false);
      reject(new Error(`Could not run ffmpeg: ${e.message}`));
    });
    child.on("close", (code, signal) => {
      track(child, false);
      if (code === 0) resolve(err);
      else if (signal || code === 255) reject(new Error("cancelled"));
      else reject(new Error(err.trim().split(/\r?\n/).slice(-4).join(" | ") || `ffmpeg exited with ${code}`));
    });
  });
}

let filterFlag: Promise<string[]> | null = null;
/** How this ffmpeg reads a filter graph from a file: "-/filter_complex" from version 7, "-filter_complex_script" before. */
function filterFileFlag(): Promise<string[]> {
  filterFlag ??= new Promise((resolve) => {
    const child = spawn("ffmpeg", ["-version"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    const done = () => {
      const m = /ffmpeg version n?(\d+)\./.exec(out);
      resolve(m && Number(m[1]) < 7 ? ["-filter_complex_script"] : ["-/filter_complex"]);
    };
    child.on("error", done);
    child.on("close", done);
  });
  return filterFlag;
}

let nvenc: Promise<boolean> | null = null;
/** Whether the graphics card can encode. Tried once with a real one-frame encode, because being listed is not proof. */
export function hasNvenc(): Promise<boolean> {
  nvenc ??= new Promise((resolve) => {
    const child = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=black:s=256x256:d=0.1", "-c:v", "h264_nvenc", "-f", "null", "-"],
      { windowsHide: true, stdio: "ignore" },
    );
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
  return nvenc;
}

export class Exporter {
  private jobs = new Map<string, ExportJob>();
  /** The ffmpeg runs of each export: parts render side by side, so there can be several. */
  private children = new Map<string, Set<ChildProcess>>();
  private cancelled = new Set<string>();

  constructor(private onChange: (job: ExportJob) => void = () => {}) {}

  get(id: string): ExportJob | undefined {
    return this.jobs.get(id);
  }

  list(projectId: string): ExportJob[] {
    return [...this.jobs.values()].filter((j) => j.projectId === projectId);
  }

  running(projectId: string): ExportJob | undefined {
    return this.list(projectId).find((j) => j.state === "running");
  }

  /** Starts an export of a frozen plan and returns at once. */
  async start(projectId: string, plan: Plan, mediaPath: (mediaId: string) => string, outPath: string, extras: ExportExtras | Encoder = {}): Promise<ExportJob> {
    const ex: ExportExtras = typeof extras === "string" ? { encoder: extras } : extras;
    if (plan.durationUs <= 0) throw new Error("There is nothing on the timeline to export.");
    if (this.running(projectId)) throw new Error("An export of this project is already running.");
    const job: ExportJob = {
      id: randomBytes(6).toString("hex"),
      projectId,
      revision: plan.revision,
      outPath,
      state: "running",
      progress: 0,
      encoder: ex.encoder ?? ((await hasNvenc()) ? "h264_nvenc" : "libx264"),
      durationUs: plan.durationUs,
      startedAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    void this.run(job, plan, mediaPath, ex);
    return job;
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.state !== "running") return false;
    this.cancelled.add(id);
    for (const child of this.children.get(id) ?? []) stopHard(child);
    return true;
  }

  private async run(job: ExportJob, plan: Plan, mediaPath: (mediaId: string) => string, extras: ExportExtras): Promise<void> {
    const dir = path.dirname(job.outPath);
    const work = path.join(dir, `.export-${job.id}`);
    const tmpOut = path.join(dir, `.export-${job.id}${path.extname(job.outPath) || ".mp4"}`);
    const options: ExportOptions = { encoder: job.encoder };
    const track = (child: ChildProcess, running: boolean) => {
      const set = this.children.get(job.id) ?? new Set<ChildProcess>();
      this.children.set(job.id, set);
      if (!running) return void set.delete(child);
      set.add(child);
      // A cancel can arrive before ffmpeg has started.
      if (this.cancelled.has(job.id)) stopHard(child);
    };
    let lastTold = 0;
    const tell = (doneUs: number) => {
      job.progress = Math.max(job.progress, Math.min(0.999, doneUs / job.durationUs));
      const now = Date.now();
      if (now - lastTold > 400) {
        lastTold = now;
        this.onChange(job);
      }
    };
    try {
      await mkdir(work, { recursive: true });
      const cues = extras.cues ?? [];
      const captions = extras.captions?.enabled ? extras.captions : null;
      const files: string[] = [];
      for (const [i, part] of partsOf(plan).entries()) {
        if (this.cancelled.has(job.id)) throw new Error("cancelled");
        const file = path.join(work, `part-${String(i).padStart(4, "0")}.mkv`);
        let burn: string | null = null;
        if (hasBurnIn(cues, Boolean(captions), plan.overlays, part.startUs, part.endUs)) {
          // A bare file name, read from the working folder: no Windows path has to survive ffmpeg's filter syntax.
          burn = `burn-${String(i).padStart(4, "0")}.ass`;
          await writeFile(path.join(work, burn), toAss(cues, captions, plan.width, plan.height, part.startUs, part.endUs, plan.overlays), "utf8");
        }
        // The filter description can run to tens of thousands of characters, more than a
        // Windows command line holds, so it goes in a file.
        const args = partArgs(plan, part, mediaPath, file, options, extras, burn);
        const at = args.indexOf("-filter_complex");
        const script = `filter-${String(i).padStart(4, "0")}.txt`;
        await writeFile(path.join(work, script), args[at + 1]!, "utf8");
        args.splice(at, 2, ...(await filterFileFlag()), script);
        await runFfmpeg(args, (us) => tell((part.startUs + us) * 0.96), track, work);
        files.push(file);
      }
      const list = path.join(work, "parts.txt");
      await writeFile(list, files.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
      // Loudness, measured over the whole joined sound (fast: audio only, from the uncompressed parts).
      // Levelling is one fixed gain for the whole video, so quiet and loud parts keep their balance, with a
      // limiter that only catches the few peaks the gain would push too high. (loudnorm's own levelling
      // rides the volume up and down whenever a fixed gain would clip, which flattens a voice.)
      const measure = ["-af", "ebur128=framelog=quiet"];
      const inI = integratedLufs(await runFfmpeg(
        ["-hide_banner", "-nostats", "-progress", "pipe:1", "-f", "concat", "-safe", "0", "-i", list, "-vn", ...measure, "-f", "null", "-"],
        (us) => tell(job.durationUs * (0.96 + 0.015 * Math.min(1, us / job.durationUs))),
        track,
      ));
      let loud: string[] = [];
      if (typeof extras.normalizeLufs === "number" && inI !== null) {
        const target = Math.max(-30, Math.min(-8, extras.normalizeLufs));
        // The limiter takes some loudness back when the voice sits far below its peaks, so the gain is
        // found by measuring: each try is an audio-only pass of a few seconds, stepping by the slope seen.
        const chain = (g: number) => `volume=${n(g)}dB,alimiter=limit=0.708:attack=2:release=60:level=false`;
        let gain = Math.max(-30, Math.min(30, target - inI));
        let prev: [number, number] = [0, inI];
        for (let tries = 0; tries < 6; tries++) {
          const got = integratedLufs(await runFfmpeg(
            ["-hide_banner", "-nostats", "-f", "concat", "-safe", "0", "-i", list, "-vn", "-af", `${chain(gain)},ebur128=framelog=quiet`, "-f", "null", "-"],
            () => undefined,
            track,
          ));
          if (got === null || Math.abs(got - target) <= 0.2) break;
          const slope = Math.max(0.25, Math.min(1, (got - prev[1]) / (gain - prev[0] || 1)));
          prev = [gain, got];
          gain = Math.max(-30, Math.min(30, gain + (target - got) / slope));
        }
        loud = ["-af", `${chain(gain)},ebur128=framelog=quiet`, "-ar", String(AUDIO_RATE)];
        job.targetLufs = target;
      }
      const final = await runFfmpeg(
        ["-hide_banner", "-y", "-nostats", "-progress", "pipe:1", "-f", "concat", "-safe", "0", "-i", list, "-c:v", "copy", ...loud, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", tmpOut],
        (us) => tell(job.durationUs * 0.975 + us * 0.025),
        track,
      );
      const out = loud.length ? integratedLufs(final) : inI;
      if (out !== null) job.loudnessLufs = Math.round(out * 10) / 10;
      if (this.cancelled.has(job.id)) throw new Error("cancelled");
      // Only a finished file ever appears under the real name.
      await rm(job.outPath, { force: true });
      await rename(tmpOut, job.outPath);
      job.sizeBytes = (await stat(job.outPath)).size;
      job.progress = 1;
      job.state = "done";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      job.state = this.cancelled.has(job.id) || message === "cancelled" ? "cancelled" : "failed";
      if (job.state === "failed") job.error = message;
      await rm(tmpOut, { force: true }).catch(() => {});
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {});
      this.children.delete(job.id);
      this.cancelled.delete(job.id);
      job.finishedAt = Date.now();
      job.speed = job.state === "done" ? job.durationUs / 1000 / Math.max(1, job.finishedAt - job.startedAt) : undefined;
      this.onChange(job);
    }
  }

  anyRunning(): boolean {
    return [...this.jobs.values()].some((j) => j.state === "running");
  }

  /** Stops every running export; used when the server shuts down. */
  stopAll(): void {
    for (const job of this.jobs.values()) if (job.state === "running") this.cancel(job.id);
  }
}
