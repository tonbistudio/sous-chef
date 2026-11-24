import { clipDurationUs, compile, type Segment } from "./compile.js";
import { mainClipsOf, mainEndUs, settleMain } from "./layout.js";
import { clone, defaultTransform, diff, fillSettings } from "./project.js";
import {
  EditError,
  TRANSITION_KINDS,
  type Clip,
  type Item,
  type Media,
  type Op,
  type Patch,
  type Project,
  type Rect,
  type Track,
  type Transaction,
  type Us,
  type Zoom,
  type Overlay,
  type TextStyle,
  type StoredTimeline,
} from "./types.js";

export interface ApplyOptions {
  /** Makes a new unique id. The prefix says what the id is for ("c", "z", ...). */
  newId: (prefix: string) => string;
}

export interface ApplyResult {
  project: Project;
  forward: Patch;
  inverse: Patch;
  /** Ids created by each op, in op order (null where an op creates nothing). */
  created: (string | null)[];
}

const MIN_CLIP_US = 1_000;
const STILL_DEFAULT_US = 5_000_000;

function fail(code: EditError["code"], message: string, details?: Record<string, unknown>): never {
  throw new EditError(code, message, details);
}

function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n);
}

function needInt(value: unknown, name: string): number {
  if (!isInt(value)) fail("invalid", `${name} must be a whole number of microseconds`);
  return value;
}

function getMedia(p: Project, id: string): Media {
  const m = p.media.find((x) => x.id === id);
  if (!m) fail("not_found", `No media with id "${id}"`);
  return m;
}

function getTrack(p: Project, id: string): Track {
  const t = p.tracks.find((x) => x.id === id);
  if (!t) fail("not_found", `No track with id "${id}"`);
  return t;
}

function getClip(p: Project, id: string): Clip {
  const item = p.items[id];
  if (!item || item.type !== "clip") fail("not_found", `No clip with id "${id}"`);
  return item;
}

function getZoom(p: Project, id: string): Zoom {
  const item = p.items[id];
  if (!item || item.type !== "zoom") fail("not_found", `No zoom with id "${id}"`);
  return item;
}

function getOverlay(p: Project, id: string): Overlay {
  const item = p.items[id];
  if (!item || item.type !== "overlay") fail("not_found", `No overlay with id "${id}"`);
  return item;
}

function checkStyle(style: Partial<TextStyle> | undefined): Partial<TextStyle> {
  const out: Partial<TextStyle> = {};
  if (!style) return out;
  if (style.size !== undefined) {
    if (typeof style.size !== "number" || !(style.size >= 0.01 && style.size <= 0.5)) fail("invalid", "style.size must be between 0.01 and 0.5 (a fraction of the picture height)");
    out.size = style.size;
  }
  if (style.color !== undefined) {
    if (typeof style.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(style.color)) fail("invalid", 'style.color must look like "#ffcc00"');
    out.color = style.color.toLowerCase();
  }
  if (style.bold !== undefined) out.bold = Boolean(style.bold);
  if (style.box !== undefined) out.box = Boolean(style.box);
  return out;
}

function checkParams(params: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(k)) fail("invalid", `Bad parameter name "${k}"`);
    out[k] = String(v).slice(0, 300);
  }
  return out;
}

function trackOf(p: Project, itemId: string): Track {
  const t = p.tracks.find((x) => x.items.includes(itemId));
  if (!t) fail("not_found", `Item "${itemId}" is not on any track`);
  return t;
}

function takeId(p: Project, wanted: string | undefined, prefix: string, opts: ApplyOptions): string {
  const used = (id: string) =>
    id in p.items ||
    p.media.some((m) => m.id === id) ||
    p.tracks.some((t) => t.id === id) ||
    p.markers.some((m) => m.id === id);
  if (wanted === undefined) {
    // Generated ids must never collide with ids a caller chose earlier.
    for (let attempt = 0; attempt < 1000; attempt++) {
      const id = opts.newId(prefix);
      if (!used(id)) return id;
    }
    fail("conflict", "Could not generate a free id");
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(wanted)) fail("invalid", `"${wanted}" is not a valid id`);
  if (used(wanted)) fail("conflict", `Id "${wanted}" is already in use`);
  return wanted;
}

function checkRect(rect: Rect): void {
  if (!Array.isArray(rect) || rect.length !== 4 || rect.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    fail("invalid", "rect must be [x, y, width, height]");
  }
  const [x, y, w, h] = rect;
  if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > 1 + 1e-9 || y + h > 1 + 1e-9) {
    fail("invalid", "rect must lie inside the picture, as fractions between 0 and 1");
  }
}

/** Length a clip occupies on the timeline, ignoring cut padding (used for overlap checks). */
function checkNoOverlap(p: Project, track: Track, clip: Clip): void {
  const hit = overlapOn(p, track, clip);
  if (hit) fail("conflict", `Clip would overlap clip "${hit}" on track "${track.id}"`);
}

/** The clip on a track (not the main track) that `clip` would overlap, by what each actually plays. */
function overlapOn(p: Project, track: Track, clip: Clip): string | null {
  if (track.kind === "main") return null;
  const a0 = clip.startUs;
  const a1 = a0 + clipDurationUs(clip, p.settings.cut);
  for (const id of track.items) {
    if (id === clip.id) continue;
    const other = p.items[id];
    if (!other || other.type !== "clip") continue;
    const b0 = other.startUs;
    const b1 = b0 + clipDurationUs(other, p.settings.cut);
    if (a0 < b1 && b0 < a1) return id;
  }
  return null;
}

function mediaFitsTrack(media: Media, track: Track): void {
  if (track.kind === "overlay") fail("invalid", "Overlay tracks do not hold media clips");
  if (track.kind === "audio" && !media.probe.hasAudio) fail("invalid", `Media "${media.id}" has no audio`);
  if (track.kind === "main" && media.kind === "image") fail("invalid", "Pictures go on a video track, not the main track");
  if ((track.kind === "main" || track.kind === "video") && media.kind === "audio") {
    fail("invalid", `Media "${media.id}" is audio only and cannot go on a ${track.kind} track`);
  }
}

/**
 * Puts a clip on the main track at its start time. Dropped onto another clip,
 * it goes in at that clip's nearer edge, and the clips after it move right.
 */
function placeOnMain(p: Project, clip: Clip): void {
  const track = p.tracks.find((t) => t.kind === "main")!;
  const others = mainClipsOf(p).filter((c) => c.id !== clip.id);
  for (const o of others) {
    const end = o.startUs + clipDurationUs(o, p.settings.cut);
    if (clip.startUs > o.startUs && clip.startUs < end) {
      clip.startUs = clip.startUs - o.startUs < end - clip.startUs ? o.startUs : end;
      break;
    }
  }
  // First in the list, so it sorts ahead of a clip that starts at the same moment.
  track.items = [clip.id, ...track.items.filter((x) => x !== clip.id)];
  settleMain(p);
}

/** After a main clip changes length, the clips after it follow, so cutting words never leaves a hole. */
function ripple(p: Project, clip: Clip, lengthBefore: number): void {
  const track = p.tracks.find((t) => t.items.includes(clip.id));
  if (track?.kind !== "main") return;
  const delta = clipDurationUs(clip, p.settings.cut) - lengthBefore;
  if (delta === 0) return;
  for (const c of mainClipsOf(p)) if (c.id !== clip.id && c.startUs > clip.startUs) c.startUs = Math.max(0, c.startUs + delta);
  settleMain(p);
}

/** A frame size an encoder takes: whole, even, and between 16 and 7680 pixels a side. */
function frameSize(width: unknown, height: unknown): [number, number] {
  if (!isInt(width) || !isInt(height)) fail("invalid", "width and height must be whole numbers of pixels");
  if (width < 16 || height < 16 || width > 7680 || height > 7680) fail("invalid", "width and height must be between 16 and 7680 pixels");
  if (width % 2 || height % 2) fail("invalid", "width and height must be even numbers");
  return [width, height];
}

function stowTimeline(p: Project): StoredTimeline {
  return {
    id: p.timelineId ?? "tl1",
    name: p.timelineName ?? "Timeline 1",
    size: { width: p.settings.width, height: p.settings.height, frameFit: p.settings.frameFit ?? "fill" },
    tracks: p.tracks,
    items: p.items,
    markers: p.markers,
  };
}

function loadTimeline(p: Project, t: StoredTimeline): void {
  p.timelineId = t.id;
  p.timelineName = t.name;
  // A timeline saved before timelines had their own size keeps the size the project had.
  if (t.size) {
    p.settings.width = t.size.width;
    p.settings.height = t.size.height;
    p.settings.frameFit = t.size.frameFit ?? "fill";
  }
  p.tracks = clone(t.tracks);
  p.items = clone(t.items);
  p.markers = clone(t.markers);
}

/** Copies a put-away timeline (or a template) into the one being edited. Without `ripple`, nothing already there moves. */
function insertTimeline(p: Project, src: StoredTimeline, atUs: number | null, opts: ApplyOptions, ripple = true): void {
  const cut = p.settings.cut;
  const lengthOf = (c: Clip) => clipDurationUs(c, cut);
  const srcItems = Object.values(src.items);
  let length = 0;
  for (const it of srcItems) {
    if (it.type === "clip") length = Math.max(length, it.startUs + lengthOf(it));
    if (it.type === "overlay") length = Math.max(length, it.startUs + it.durationUs);
  }
  if (length <= 0) fail("invalid", `"${src.name}" is empty`);
  // Where it goes: never into the middle of a main clip.
  let at = atUs ?? mainEndUs(p);
  if (ripple) {
    for (const c of mainClipsOf(p)) {
      const end = c.startUs + lengthOf(c);
      if (at > c.startUs && at < end) at = at - c.startUs < end - at ? c.startUs : end;
    }
  }
  at = Math.max(0, at);
  // Everything from there on moves right to make room.
  if (ripple) {
    for (const it of Object.values(p.items)) {
      if ((it.type === "clip" || it.type === "overlay") && it.startUs >= at) it.startUs += length;
    }
    for (const m of p.markers) if (m.timeUs >= at) m.timeUs += length;
  }

  const fresh = (prefix: string) => {
    for (let i = 0; i < 1000; i++) {
      const id = opts.newId(prefix);
      if (!(id in p.items) && !p.tracks.some((t) => t.id === id) && !p.markers.some((m) => m.id === id)) return id;
    }
    return fail("conflict", "Could not generate a free id");
  };
  const overlaps = (track: Track, start: number, end: number) =>
    track.items.some((id) => {
      const o = p.items[id];
      return o?.type === "clip" && o.startUs < end && start < o.startUs + lengthOf(o);
    });
  for (const st of src.tracks) {
    const copies = st.items.map((id) => src.items[id]).filter((x): x is Item => Boolean(x)).map((x) => clone(x));
    if (!copies.length) continue;
    let target: Track | undefined;
    if (st.kind === "main") target = p.tracks.find((t) => t.kind === "main");
    else if (st.kind === "overlay") target = p.tracks.find((t) => t.kind === "overlay");
    else {
      // An existing track of the same kind with room for all of them, or a new one.
      target = p.tracks.find((t) => t.kind === st.kind && copies.every((c) => c.type !== "clip" || !overlaps(t, c.startUs + at, c.startUs + at + lengthOf(c))));
    }
    if (!target) {
      target = { id: fresh("t"), kind: st.kind, name: st.name, muted: st.muted, locked: false, items: [] };
      p.tracks.push(target);
    }
    for (const c of copies) {
      if (c.type !== "clip" && c.type !== "overlay") continue;
      if (c.type === "clip" && !p.media.some((m) => m.id === c.mediaId)) continue;
      c.id = fresh(c.type === "clip" ? "c" : "o");
      c.startUs += at;
      p.items[c.id] = c;
      target.items.push(c.id);
    }
  }
  // Zooms belong to a take, not a place on the timeline; bring the ones this timeline does not already have.
  const zooms = Object.values(p.items).filter((i): i is Zoom => i.type === "zoom");
  for (const z of srcItems) {
    if (z.type !== "zoom" || zooms.some((e) => e.mediaId === z.mediaId && e.startUs < z.endUs && z.startUs < e.endUs)) continue;
    const copy = clone(z);
    copy.id = fresh("z");
    p.items[copy.id] = copy;
  }
  for (const m of src.markers) p.markers.push({ id: fresh("k"), timeUs: m.timeUs + at, label: m.label });
  p.markers.sort((a, b) => a.timeUs - b.timeUs);
  settleMain(p);
}

/**
 * Changes the speed of a timeline's main track from `old` to `speed`. Main
 * clips play faster or slower; everything placed in timeline time (other
 * clips, text, graphics, markers, gaps) moves so it stays with the same
 * moment of the recording. Voiceover and music keep their own speed.
 */
function rescaleTimeline(t: StoredTimeline, old: number, speed: number, settings: Project["settings"], stills: Set<string>): void {
  const k = old / speed;
  const at = (us: number) => Math.max(0, Math.round(us * k));
  const main = new Set(t.tracks.find((tr) => tr.kind === "main")?.items ?? []);
  for (const it of Object.values(t.items)) {
    if (it.type === "clip") {
      if (main.has(it.id)) it.speed = Math.round(((it.speed || 1) * speed) / old * 1e6) / 1e6;
      else if (stills.has(it.mediaId)) it.sourceOutUs = it.sourceInUs + Math.max(100_000, Math.round((it.sourceOutUs - it.sourceInUs) * k));
      it.startUs = at(it.startUs);
    } else if (it.type === "overlay") {
      it.startUs = at(it.startUs);
      it.durationUs = Math.max(100_000, Math.round(it.durationUs * k));
    }
  }
  for (const m of t.markers) m.timeUs = at(m.timeUs);
  // Rounding must not leave clips that met overlapping by a microsecond.
  const clips = [...main].map((id) => t.items[id]).filter((c): c is Clip => c?.type === "clip").sort((a, b) => a.startUs - b.startUs);
  let cursor = 0;
  for (const c of clips) {
    if (c.startUs < cursor) c.startUs = cursor;
    cursor = c.startUs + clipDurationUs(c, settings.cut);
  }
}

function applyOp(p: Project, op: Op, by: Transaction["by"], opts: ApplyOptions): string | null {
  switch (op.op) {
    case "media.add": {
      const id = takeId(p, op.media.id, "m", opts);
      if (typeof op.media.path !== "string" || !op.media.path) fail("invalid", "media.path is required");
      if (!isInt(op.media.durationUs) || op.media.durationUs < 0) fail("invalid", "media.durationUs is required");
      p.media.push({ ...clone(op.media), id });
      return id;
    }
    case "media.relink": {
      const media = getMedia(p, op.mediaId);
      const next = op.media;
      if (typeof next?.path !== "string" || !next.path) fail("invalid", "media.path is required");
      if (!isInt(next.durationUs)) fail("invalid", "media.durationUs is required");
      if (next.kind && next.kind !== media.kind) fail("invalid", `That file is ${next.kind === "image" ? "a picture" : `${next.kind}`}, but "${media.id}" is ${media.kind}`);
      if (media.kind !== "image" && Math.abs((next.durationUs as number) - media.durationUs) > 1_000_000) {
        fail("invalid", "That file has a different length, so it is not the same recording", { expectedUs: media.durationUs, foundUs: next.durationUs });
      }
      media.path = next.path;
      if (next.probe) media.probe = clone(next.probe);
      if (next.fingerprint) media.fingerprint = clone(next.fingerprint);
      return null;
    }
    case "media.remove": {
      getMedia(p, op.mediaId);
      const users = Object.values(p.items).filter((i) => i.type === "clip" && i.mediaId === op.mediaId);
      if (users.length) {
        fail("conflict", `Media "${op.mediaId}" is still used by ${users.length} clip(s)`, {
          clipIds: users.map((u) => u.id),
        });
      }
      p.media = p.media.filter((m) => m.id !== op.mediaId);
      for (const item of Object.values(p.items)) {
        if (item.type === "zoom" && item.mediaId === op.mediaId) delete p.items[item.id];
      }
      delete p.wordFixes[op.mediaId];
      return null;
    }
    case "track.add": {
      if ((op.kind as string) === "main") fail("invalid", "A project has exactly one main track");
      if (!["video", "audio", "overlay"].includes(op.kind)) fail("invalid", `Unknown track kind "${op.kind}"`);
      const id = takeId(p, op.id, "t", opts);
      const track: Track = { id, kind: op.kind, name: op.name ?? "", muted: false, locked: false, items: [] };
      const index = op.index === undefined ? p.tracks.length : Math.max(0, Math.min(p.tracks.length, op.index));
      p.tracks.splice(index, 0, track);
      return id;
    }
    case "track.remove": {
      const track = getTrack(p, op.trackId);
      if (track.kind === "main") fail("invalid", "The main track cannot be removed");
      for (const id of track.items) delete p.items[id];
      p.tracks = p.tracks.filter((t) => t.id !== op.trackId);
      return null;
    }
    case "track.set": {
      const track = getTrack(p, op.trackId);
      if (op.name !== undefined) track.name = String(op.name);
      if (op.muted !== undefined) track.muted = Boolean(op.muted);
      if (op.locked !== undefined) track.locked = Boolean(op.locked);
      return null;
    }
    case "clip.add": {
      const track = getTrack(p, op.trackId);
      const media = getMedia(p, op.mediaId);
      mediaFitsTrack(media, track);
      const sourceInUs = op.sourceInUs === undefined ? 0 : needInt(op.sourceInUs, "sourceInUs");
      // A still picture has no length of its own: it shows for as long as its clip says, five seconds unless told.
      const still = media.kind === "image";
      const sourceOutUs = op.sourceOutUs === undefined ? (still ? sourceInUs + STILL_DEFAULT_US : media.durationUs) : needInt(op.sourceOutUs, "sourceOutUs");
      if (sourceInUs < 0 || (!still && sourceOutUs > media.durationUs) || sourceOutUs - sourceInUs < MIN_CLIP_US) {
        fail("invalid", "Clip range must lie inside the media and not be empty", {
          mediaDurationUs: media.durationUs,
        });
      }
      const id = takeId(p, op.id, "c", opts);
      const clip: Clip = {
        id,
        type: "clip",
        mediaId: media.id,
        sourceInUs,
        sourceOutUs,
        startUs: 0,
        removed: [],
        // The main track plays at the project's speed; other tracks at their own.
        speed: track.kind === "main" ? (p.settings.mainSpeed ?? 1) : 1,
        volumeDb: 0,
        muted: false,
        fadeInUs: 0,
        fadeOutUs: 0,
        transform: defaultTransform(),
      };
      if (track.kind === "main") {
        const others = mainClipsOf(p);
        if (op.startUs !== undefined) {
          clip.startUs = needInt(op.startUs, "startUs");
          if (clip.startUs < 0) fail("invalid", "startUs cannot be negative");
        } else if (op.index !== undefined && others[Math.max(0, op.index)]) {
          // Goes in before the clip now at that position; that clip and the ones after it move right.
          clip.startUs = others[Math.max(0, op.index)]!.startUs;
        } else clip.startUs = mainEndUs(p);
        p.items[id] = clip;
        placeOnMain(p, clip);
        return id;
      } else {
        clip.startUs = needInt(op.startUs ?? 0, "startUs");
        if (clip.startUs < 0) fail("invalid", "startUs cannot be negative");
        checkNoOverlap(p, track, clip);
        track.items.push(id);
      }
      p.items[id] = clip;
      return id;
    }
    case "clip.remove": {
      getClip(p, op.clipId);
      const track = trackOf(p, op.clipId);
      track.items = track.items.filter((x) => x !== op.clipId);
      delete p.items[op.clipId];
      return null;
    }
    case "clip.move": {
      const clip = getClip(p, op.clipId);
      const from = trackOf(p, op.clipId);
      const to = op.trackId ? getTrack(p, op.trackId) : from;
      if (to.id !== from.id) mediaFitsTrack(getMedia(p, clip.mediaId), to);
      const wasMain = from.kind === "main";
      const oldStart = clip.startUs;
      const oldDur = clipDurationUs(clip, p.settings.cut);
      from.items = from.items.filter((x) => x !== op.clipId);
      if (to.kind === "main") {
        if (op.startUs !== undefined) {
          clip.startUs = needInt(op.startUs, "startUs");
          if (clip.startUs < 0) fail("invalid", "startUs cannot be negative");
        } else {
          // Moving by position: the space it leaves closes, then it goes in before the clip at that position.
          if (wasMain) for (const c of mainClipsOf(p)) if (c.startUs > oldStart) c.startUs = Math.max(0, c.startUs - oldDur);
          const others = mainClipsOf(p);
          const target = op.index === undefined ? undefined : others[Math.max(0, op.index)];
          clip.startUs = target ? target.startUs : mainEndUs(p);
        }
        placeOnMain(p, clip);
      } else {
        if (op.startUs !== undefined) clip.startUs = needInt(op.startUs, "startUs");
        if (clip.startUs < 0) fail("invalid", "startUs cannot be negative");
        to.items.push(clip.id);
        checkNoOverlap(p, to, clip);
      }
      return null;
    }
    case "clip.trim": {
      const clip = getClip(p, op.clipId);
      const media = getMedia(p, clip.mediaId);
      const inUs = op.sourceInUs === undefined ? clip.sourceInUs : needInt(op.sourceInUs, "sourceInUs");
      const outUs = op.sourceOutUs === undefined ? clip.sourceOutUs : needInt(op.sourceOutUs, "sourceOutUs");
      if (inUs < 0 || (media.kind !== "image" && outUs > media.durationUs) || outUs - inUs < MIN_CLIP_US) {
        fail("invalid", "Trimmed range must lie inside the media and not be empty", {
          mediaDurationUs: media.durationUs,
        });
      }
      const track = trackOf(p, clip.id);
      // Trimming the front keeps what is left where it was: the clip starts later (or earlier when pulled back out).
      if (track.kind === "main" && inUs !== clip.sourceInUs) clip.startUs = Math.max(0, clip.startUs + Math.round((inUs - clip.sourceInUs) / clip.speed));
      clip.sourceInUs = inUs;
      clip.sourceOutUs = outUs;
      checkNoOverlap(p, track, clip);
      if (track.kind === "main") settleMain(p);
      return null;
    }
    case "clip.split": {
      const clip = getClip(p, op.clipId);
      const at = needInt(op.atSourceUs, "atSourceUs");
      if (at - clip.sourceInUs < MIN_CLIP_US || clip.sourceOutUs - at < MIN_CLIP_US) {
        fail("invalid", "Split point must lie inside the clip, away from its ends");
      }
      const track = trackOf(p, clip.id);
      const id = takeId(p, op.newId, "c", opts);
      const second: Clip = clone(clip);
      second.id = id;
      second.sourceInUs = at;
      second.fadeInUs = 0;
      second.removed = [];
      const first: Clip = clip;
      const firstRemoved = [];
      for (const r of clip.removed) {
        if (r.endUs <= at) firstRemoved.push(r);
        else if (r.startUs >= at) second.removed.push(r);
        else {
          firstRemoved.push({ ...r, endUs: at });
          second.removed.push({ ...r, id: opts.newId("r"), startUs: at });
        }
      }
      first.removed = firstRemoved;
      first.sourceOutUs = at;
      first.fadeOutUs = 0;
      second.startUs = first.startUs + (track.kind === "main" ? clipDurationUs(first, p.settings.cut) : Math.round((at - first.sourceInUs) / first.speed));
      track.items.splice(track.items.indexOf(clip.id) + 1, 0, id);
      p.items[id] = second;
      if (track.kind === "main") settleMain(p);
      return id;
    }
    case "clip.set": {
      const clip = getClip(p, op.clipId);
      if (op.speed !== undefined) {
        if (typeof op.speed !== "number" || !(op.speed >= 0.1 && op.speed <= 16)) {
          fail("invalid", "speed must be between 0.1 and 16");
        }
        clip.speed = op.speed;
      }
      if (op.volumeDb !== undefined) {
        if (typeof op.volumeDb !== "number" || !(op.volumeDb >= -60 && op.volumeDb <= 24)) {
          fail("invalid", "volumeDb must be between -60 and 24");
        }
        clip.volumeDb = op.volumeDb;
      }
      if (op.muted !== undefined) clip.muted = Boolean(op.muted);
      if (op.linked !== undefined) {
        if (!op.linked) delete clip.link;
        else if (!clip.link) {
          if (trackOf(p, clip.id).kind === "main") fail("invalid", "Clips on the main track are the picture; lock a voiceover or overlay to them instead");
          clip.link = { mediaId: "", srcUs: 0 }; // filled in once the edit is done, from what plays under its start
        }
      }
      if (op.fadeInUs !== undefined) clip.fadeInUs = Math.max(0, needInt(op.fadeInUs, "fadeInUs"));
      if (op.fadeOutUs !== undefined) clip.fadeOutUs = Math.max(0, needInt(op.fadeOutUs, "fadeOutUs"));
      if (op.transform) {
        if (op.transform.crop) checkRect(op.transform.crop);
        clip.transform = { ...clip.transform, ...clone(op.transform) };
      }
      if (op.transitionIn !== undefined) {
        if (op.transitionIn === null) delete clip.transitionIn;
        else {
          const t = op.transitionIn;
          if (!t || !TRANSITION_KINDS.includes(t.kind)) fail("invalid", `transitionIn.kind must be one of ${TRANSITION_KINDS.join(", ")}`);
          const d = needInt(t.durationUs, "transitionIn.durationUs");
          if (!(d >= 100_000 && d <= 4_000_000)) fail("invalid", "transitionIn.durationUs must be between 0.1 and 4 seconds");
          if (trackOf(p, clip.id).kind !== "main") fail("invalid", "Transitions go between clips on the main track");
          clip.transitionIn = { kind: t.kind, durationUs: d };
        }
      }
      const track = trackOf(p, clip.id);
      checkNoOverlap(p, track, clip);
      if (track.kind === "main") settleMain(p);
      return null;
    }
    case "range.remove": {
      const clip = getClip(p, op.clipId);
      const lengthBefore = clipDurationUs(clip, p.settings.cut);
      const startUs = Math.max(clip.sourceInUs, needInt(op.startUs, "startUs"));
      const endUs = Math.min(clip.sourceOutUs, needInt(op.endUs, "endUs"));
      if (endUs <= startUs) fail("invalid", "Range to remove must overlap the clip");
      const id = op.id ?? opts.newId("r");
      if (clip.removed.some((r) => r.id === id)) fail("conflict", `Range id "${id}" is already in use`);
      clip.removed.push({
        id,
        startUs,
        endUs,
        why: op.why ?? "user",
        by,
        pad: op.pad ?? false,
        ...(op.wordIds ? { wordIds: [...op.wordIds] } : {}),
      });
      clip.removed.sort((a, b) => a.startUs - b.startUs);
      ripple(p, clip, lengthBefore);
      return id;
    }
    case "range.restore": {
      const clip = getClip(p, op.clipId);
      const missing = op.rangeIds.filter((id) => !clip.removed.some((r) => r.id === id));
      if (missing.length) fail("not_found", `No removed range(s) ${missing.join(", ")} in clip "${clip.id}"`);
      const lengthBefore = clipDurationUs(clip, p.settings.cut);
      clip.removed = clip.removed.filter((r) => !op.rangeIds.includes(r.id));
      ripple(p, clip, lengthBefore);
      return null;
    }
    case "zoom.add": {
      const media = getMedia(p, op.mediaId);
      const startUs = needInt(op.startUs, "startUs");
      const endUs = needInt(op.endUs, "endUs");
      if (startUs < 0 || endUs > media.durationUs || endUs <= startUs) {
        fail("invalid", "Zoom range must lie inside the media and not be empty");
      }
      checkRect(op.rect);
      const id = takeId(p, op.id, "z", opts);
      const zoom: Zoom = {
        id,
        type: "zoom",
        mediaId: media.id,
        startUs,
        endUs,
        rect: [...op.rect] as Rect,
        inUs: op.inUs ?? null,
        outUs: op.outUs ?? null,
        maxScale: op.maxScale ?? null,
        by,
      };
      p.items[id] = zoom;
      return id;
    }
    case "zoom.set": {
      const zoom = getZoom(p, op.zoomId);
      const media = getMedia(p, zoom.mediaId);
      if (op.startUs !== undefined) zoom.startUs = needInt(op.startUs, "startUs");
      if (op.endUs !== undefined) zoom.endUs = needInt(op.endUs, "endUs");
      if (zoom.startUs < 0 || zoom.endUs > media.durationUs || zoom.endUs <= zoom.startUs) {
        fail("invalid", "Zoom range must lie inside the media and not be empty");
      }
      if (op.rect) {
        checkRect(op.rect);
        zoom.rect = [...op.rect] as Rect;
      }
      if (op.inUs !== undefined) zoom.inUs = op.inUs;
      if (op.outUs !== undefined) zoom.outUs = op.outUs;
      if (op.maxScale !== undefined) zoom.maxScale = op.maxScale;
      return null;
    }
    case "zoom.remove": {
      getZoom(p, op.zoomId);
      delete p.items[op.zoomId];
      return null;
    }
    case "overlay.add": {
      if (op.kind !== "text" && op.kind !== "hyperframes") fail("invalid", `Unknown overlay kind "${String(op.kind)}"`);
      const startUs = needInt(op.startUs, "startUs");
      const durationUs = needInt(op.durationUs, "durationUs");
      if (startUs < 0 || durationUs < 100_000) fail("invalid", "An overlay needs a start of 0 or more and a length of at least 0.1 s");
      if (op.kind === "text" && !(typeof op.text === "string" && op.text.trim())) fail("invalid", "A text overlay needs text");
      if (op.kind === "hyperframes" && !(typeof op.template === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(op.template))) {
        fail("invalid", "A HyperFrames overlay needs a template name");
      }
      let track = op.trackId ? getTrack(p, op.trackId) : p.tracks.find((t) => t.kind === "overlay");
      if (!track) {
        track = { id: takeId(p, undefined, "t", opts), kind: "overlay", name: "Overlays", muted: false, locked: false, items: [] };
        p.tracks.push(track);
      }
      if (track.kind !== "overlay") fail("invalid", `Track "${track.id}" is not an overlay track`);
      const id = takeId(p, op.id, "o", opts);
      if (op.transform?.crop) checkRect(op.transform.crop);
      const overlay: Overlay = {
        id,
        type: "overlay",
        kind: op.kind,
        startUs,
        durationUs,
        text: String(op.text ?? "").slice(0, 500),
        style: { size: 0.06, color: "#ffffff", bold: true, box: true, ...checkStyle(op.style) },
        ...(op.template ? { template: op.template } : {}),
        ...(op.params ? { params: checkParams(op.params) } : {}),
        transform: { ...defaultTransform(), ...clone(op.transform ?? {}) },
        fadeInUs: Math.max(0, needInt(op.fadeInUs ?? 200_000, "fadeInUs")),
        fadeOutUs: Math.max(0, needInt(op.fadeOutUs ?? 200_000, "fadeOutUs")),
        by,
      };
      p.items[id] = overlay;
      track.items.push(id);
      return id;
    }
    case "overlay.set": {
      const o = getOverlay(p, op.overlayId);
      if (op.startUs !== undefined) o.startUs = Math.max(0, needInt(op.startUs, "startUs"));
      if (op.durationUs !== undefined) {
        o.durationUs = needInt(op.durationUs, "durationUs");
        if (o.durationUs < 100_000) fail("invalid", "An overlay must last at least 0.1 s");
      }
      if (op.text !== undefined) {
        if (o.kind === "text" && !String(op.text).trim()) fail("invalid", "A text overlay needs text");
        o.text = String(op.text).slice(0, 500);
      }
      if (op.style) o.style = { ...o.style, ...checkStyle(op.style) };
      if (op.params) o.params = { ...(o.params ?? {}), ...checkParams(op.params) };
      if (op.transform) {
        if (op.transform.crop) checkRect(op.transform.crop);
        o.transform = { ...o.transform, ...clone(op.transform) };
      }
      if (op.fadeInUs !== undefined) o.fadeInUs = Math.max(0, needInt(op.fadeInUs, "fadeInUs"));
      if (op.fadeOutUs !== undefined) o.fadeOutUs = Math.max(0, needInt(op.fadeOutUs, "fadeOutUs"));
      return null;
    }
    case "overlay.remove": {
      getOverlay(p, op.overlayId);
      for (const t of p.tracks) t.items = t.items.filter((x) => x !== op.overlayId);
      delete p.items[op.overlayId];
      return null;
    }
    case "gap.close": {
      const clips = mainClipsOf(p);
      if (op.atUs === undefined) {
        let cursor = 0;
        for (const c of clips) {
          c.startUs = cursor;
          cursor += clipDurationUs(c, p.settings.cut);
        }
        return null;
      }
      const at = needInt(op.atUs, "atUs");
      let prevEnd = 0;
      for (const c of clips) {
        if (at >= prevEnd && at < c.startUs) {
          const gap = c.startUs - prevEnd;
          for (const later of clips) if (later.startUs >= c.startUs) later.startUs -= gap;
          return null;
        }
        prevEnd = c.startUs + clipDurationUs(c, p.settings.cut);
      }
      return fail("invalid", "There is no gap on the main track at that time");
    }
    case "timeline.add": {
      const lines = p.timelines ?? [];
      const id = op.id ?? opts.newId("tl");
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || id === p.timelineId || lines.some((t) => t.id === id)) fail("conflict", `Timeline id "${id}" is not free`);
      p.timelines = [...lines, stowTimeline(p)];
      p.timelineOrder = [...(p.timelineOrder ?? [p.timelineId ?? "tl1", ...lines.map((t) => t.id)]), id];
      p.timelineId = id;
      p.timelineName = String(op.name ?? `Timeline ${p.timelines.length + 1}`).slice(0, 80);
      // New timelines start 16:9 unless a size is given.
      const [w, h] = op.width !== undefined || op.height !== undefined ? frameSize(op.width, op.height) : [1920, 1080];
      p.settings.width = w;
      p.settings.height = h;
      p.settings.frameFit = "fill";
      p.tracks = [{ id: "main", kind: "main", name: "Main", muted: false, locked: false, items: [] }];
      p.items = {};
      p.markers = [];
      return id;
    }
    case "timeline.size": {
      const [w, h] = frameSize(op.width, op.height);
      p.settings.width = w;
      p.settings.height = h;
      if (op.frameFit !== undefined) {
        if (op.frameFit !== "fill" && op.frameFit !== "fit") fail("invalid", 'frameFit must be "fill" or "fit"');
        p.settings.frameFit = op.frameFit;
      }
      return null;
    }
    case "timeline.switch": {
      if (op.timelineId === p.timelineId) return null;
      const next = (p.timelines ?? []).find((t) => t.id === op.timelineId);
      if (!next) fail("not_found", `No timeline with id "${op.timelineId}"`);
      const put = stowTimeline(p);
      loadTimeline(p, next);
      p.timelines = [...(p.timelines ?? []).filter((t) => t.id !== next.id), put];
      return null;
    }
    case "timeline.rename": {
      const name = String(op.name ?? "").trim().slice(0, 80);
      if (!name) fail("invalid", "A timeline needs a name");
      if (op.timelineId === p.timelineId) p.timelineName = name;
      else {
        const t = (p.timelines ?? []).find((x) => x.id === op.timelineId);
        if (!t) fail("not_found", `No timeline with id "${op.timelineId}"`);
        t.name = name;
      }
      return null;
    }
    case "timeline.remove": {
      const lines = p.timelines ?? [];
      if (!lines.length) fail("invalid", "A project needs at least one timeline");
      if (op.timelineId === p.timelineId) {
        const next = lines[0]!;
        loadTimeline(p, next);
        p.timelines = lines.slice(1);
      } else {
        if (!lines.some((t) => t.id === op.timelineId)) fail("not_found", `No timeline with id "${op.timelineId}"`);
        p.timelines = lines.filter((t) => t.id !== op.timelineId);
      }
      p.timelineOrder = (p.timelineOrder ?? []).filter((id) => id !== op.timelineId);
      return null;
    }
    case "template.insert": {
      const t = op.template;
      if (!t || !Array.isArray(t.tracks) || !Array.isArray(t.markers ?? [])) fail("invalid", "template must have tracks");
      fillSettings(p);
      const src: StoredTimeline = { id: "template", name: String(t.name ?? "Template"), tracks: [], items: {}, markers: clone(t.markers ?? []) };
      let k = 0;
      let hasMain = false;
      for (const tr of t.tracks) {
        if (!["main", "video", "audio", "overlay"].includes(tr.kind)) fail("invalid", `Unknown track kind "${tr.kind}"`);
        const ids: string[] = [];
        for (const raw of tr.items ?? []) {
          const it = clone(raw);
          if (it.type !== "clip" && it.type !== "overlay") continue;
          if (typeof it.startUs !== "number" || it.startUs < 0) fail("invalid", "Template items need a start time");
          it.id = `tpl${k++}`;
          src.items[it.id] = it;
          ids.push(it.id);
          if (tr.kind === "main" && it.type === "clip") hasMain = true;
        }
        src.tracks.push({ id: `tt${src.tracks.length}`, kind: tr.kind, name: tr.name || tr.kind, muted: false, locked: false, items: ids });
      }
      if (!Object.keys(src.items).length) fail("invalid", "The template is empty");
      const made = Number(t.mainSpeed) || 1;
      const now = p.settings.mainSpeed || 1;
      if (Math.abs(made - now) > 1e-9) rescaleTimeline(src, made, now, p.settings, new Set(p.media.filter((m) => m.kind === "image").map((m) => m.id)));
      insertTimeline(p, src, op.atUs === undefined ? null : needInt(op.atUs, "atUs"), opts, hasMain);
      return null;
    }
    case "timeline.insert": {
      const src = (p.timelines ?? []).find((t) => t.id === op.timelineId);
      if (!src) fail(op.timelineId === p.timelineId ? "invalid" : "not_found", op.timelineId === p.timelineId ? "A timeline cannot be put into itself" : `No timeline with id "${op.timelineId}"`);
      insertTimeline(p, src, op.atUs === undefined ? null : needInt(op.atUs, "atUs"), opts);
      return null;
    }
    case "word.fix": {
      getMedia(p, op.mediaId);
      if (typeof op.wordId !== "string" || !op.wordId) fail("invalid", "wordId is required");
      const fixes = { ...(p.wordFixes[op.mediaId] ?? {}) };
      if (op.text === null || op.text === "") delete fixes[op.wordId];
      else if (typeof op.text === "string" && op.text.length <= 200) fixes[op.wordId] = op.text;
      else fail("invalid", "text must be a string of at most 200 characters, or null");
      p.wordFixes = { ...p.wordFixes, [op.mediaId]: fixes };
      if (Object.keys(fixes).length === 0) delete p.wordFixes[op.mediaId];
      return null;
    }
    case "marker.add": {
      const id = takeId(p, op.id, "k", opts);
      const timeUs = needInt(op.timeUs, "timeUs");
      if (timeUs < 0) fail("invalid", "timeUs cannot be negative");
      p.markers.push({ id, timeUs, label: op.label ?? "" });
      p.markers.sort((a, b) => a.timeUs - b.timeUs);
      return id;
    }
    case "marker.update": {
      const m = p.markers.find((x) => x.id === op.markerId);
      if (!m) fail("not_found", `No marker with id "${op.markerId}"`);
      if (op.label !== undefined) {
        if (typeof op.label !== "string" || op.label.length > 100) fail("invalid", "label must be a string of at most 100 characters");
        m!.label = op.label.trim();
      }
      if (op.timeUs !== undefined) {
        const timeUs = needInt(op.timeUs, "timeUs");
        if (timeUs < 0) fail("invalid", "timeUs cannot be negative");
        m!.timeUs = timeUs;
        p.markers.sort((a, b) => a.timeUs - b.timeUs);
      }
      return null;
    }
    case "marker.remove": {
      if (!p.markers.some((m) => m.id === op.markerId)) fail("not_found", `No marker with id "${op.markerId}"`);
      p.markers = p.markers.filter((m) => m.id !== op.markerId);
      return null;
    }
    case "project.speed": {
      const speed = Number(op.speed);
      if (!(speed >= 0.25 && speed <= 4)) fail("invalid", "speed must be between 0.25 and 4");
      fillSettings(p);
      const old = p.settings.mainSpeed || 1;
      if (Math.abs(old - speed) < 1e-9) return null;
      p.settings.mainSpeed = speed;
      // Every timeline, the open one and the put-away ones.
      const open = stowTimeline(p);
      // Pictures have no length of their own: the time they show for is kept as a source range, so it scales too.
      const stills = new Set(p.media.filter((m) => m.kind === "image").map((m) => m.id));
      for (const t of [open, ...(p.timelines ?? [])]) rescaleTimeline(t, old, speed, p.settings, stills);
      settleMain(p);
      return null;
    }
    case "settings.set": {
      const s = op.settings ?? {};
      if ("mainSpeed" in s) fail("invalid", "Change the main track speed with the project.speed op");
      fillSettings(p);
      const cur = p.settings as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(s)) {
        if (!(key in cur)) fail("invalid", `Unknown setting "${key}"`);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const group = cur[key] as Record<string, unknown>;
          for (const [k2, v2] of Object.entries(value)) {
            if (!(k2 in group)) fail("invalid", `Unknown setting "${key}.${k2}"`);
            if (typeof v2 !== typeof group[k2]) fail("invalid", `Setting "${key}.${k2}" has the wrong type`);
            group[k2] = v2;
          }
        } else {
          if (typeof value !== typeof cur[key]) fail("invalid", `Setting "${key}" has the wrong type`);
          cur[key] = value;
        }
      }
      const { width, height, fps } = p.settings;
      if (!(width >= 16 && height >= 16 && fps >= 1 && fps <= 240)) fail("invalid", "Picture size or frame rate out of range");
      if (p.settings.frameFit !== "fill" && p.settings.frameFit !== "fit") fail("invalid", 'frameFit must be "fill" or "fit"');
      return null;
    }
    default: {
      const unknown = op as { op?: string };
      return fail("invalid", `Unknown operation "${unknown.op}"`);
    }
  }
}

/**
 * Clips locked to the picture (a voiceover locked to the screen recording) keep their place in it.
 *
 * A locked clip remembers a moment of a main-track recording: the one playing where the clip starts.
 * After every edit it is put back where that moment now plays, so footage added, removed or moved in
 * front of it carries it along. Moving the locked clip itself (or splitting or trimming it) locks it to
 * whatever is under its new start. When the moment was cut out, it goes where the recording picks up
 * again. A clip that lands on another clip in its lane moves to a free lane of the same kind.
 */
function settleLinked(before: Project, after: Project, opts: ApplyOptions): void {
  const linked: { clip: Clip; track: Track }[] = [];
  for (const track of after.tracks) {
    if (track.kind === "main") {
      for (const id of track.items) {
        const c = after.items[id];
        if (c?.type === "clip" && c.link) delete c.link; // main-track clips are the picture itself
      }
      continue;
    }
    for (const id of track.items) {
      const c = after.items[id];
      if (c?.type === "clip" && c.link) linked.push({ clip: c, track });
    }
  }
  if (!linked.length) return;
  const mainOf = (p: Project) => compile(p).segments.filter((s) => s.trackKind === "main" && s.hasVideo);
  const main = mainOf(after);
  let old: Segment[] | null = null;
  const sourceAt = (segs: Segment[], tl: Us): { mediaId: string; srcUs: Us; clipId: string } | null => {
    for (const s of segs) if (tl >= s.tlStartUs && tl < s.tlEndUs) return { mediaId: s.mediaId, srcUs: s.srcInUs + Math.round((tl - s.tlStartUs) * s.speed), clipId: s.clipId };
    return null;
  };
  // Where the remembered moment plays now. The same footage can be on the timeline more than once (a
  // recording added twice, or a clip split in two), so the clip it was locked to wins, then the copy
  // nearest to where it was. A moment that was cut out goes where that footage picks up again.
  const placeOf = (link: { mediaId: string; srcUs: Us; clipId?: string }, near: Us): { at: Us; clipId: string } | null => {
    const score = (s: Segment, at: Us) => (s.clipId === link.clipId ? -1 : Math.abs(at - near));
    let best: { at: Us; clipId: string; score: number } | null = null;
    for (const s of main) {
      if (s.mediaId !== link.mediaId || link.srcUs < s.srcInUs || link.srcUs >= s.srcOutUs) continue;
      const at = s.tlStartUs + Math.round((link.srcUs - s.srcInUs) / s.speed);
      const sc = score(s, at);
      if (!best || sc < best.score) best = { at, clipId: s.clipId, score: sc };
    }
    if (best) return best;
    // Cut out: the nearest later footage of that recording, in the same clip if there is any.
    let next: Segment | null = null;
    const rank = (s: Segment) => [s.clipId === link.clipId ? 0 : 1, s.srcInUs - link.srcUs, Math.abs(s.tlStartUs - near)];
    for (const s of main) {
      if (s.mediaId !== link.mediaId || s.srcInUs < link.srcUs) continue;
      if (!next) { next = s; continue; }
      const a = rank(s), b = rank(next);
      if (a[0]! < b[0]! || (a[0] === b[0] && (a[1]! < b[1]! || (a[1] === b[1] && a[2]! < b[2]!)))) next = s;
    }
    return next ? { at: next.tlStartUs, clipId: next.clipId } : null;
  };
  const moved: { clip: Clip; track: Track }[] = [];
  for (const entry of linked) {
    const { clip } = entry;
    const prev = before.items[clip.id];
    const own = !prev || prev.type !== "clip" || prev.startUs !== clip.startUs || !clip.link!.mediaId;
    if (own) {
      // The clip itself was moved, split, trimmed or just locked: lock it to what is under its start.
      // Its start was set against the timeline as it stood before this edit (a split or trim in the same
      // edit as a cut on the main track must not pick up footage that only arrives with the cut).
      old ??= mainOf(before);
      const hit = sourceAt(old, clip.startUs) ?? sourceAt(main, clip.startUs);
      if (hit) {
        clip.link = hit;
        const p = placeOf(hit, clip.startUs);
        if (p && p.at !== clip.startUs) {
          clip.startUs = p.at;
          moved.push(entry);
        }
      } else if (!clip.link!.mediaId) fail("invalid", "There is no screen recording under the start of that clip to lock it to");
      else delete clip.link;
      continue;
    }
    // Where it was, in the timeline as it stood: the starting guess for which copy of the footage it is with.
    const p = placeOf(clip.link!, clip.startUs);
    if (!p) continue;
    clip.link = { ...clip.link!, clipId: p.clipId };
    if (p.at === clip.startUs) continue;
    clip.startUs = p.at;
    moved.push(entry);
  }
  // Something it now lands on: the first lane of its kind with room, or a new lane just below.
  moved.sort((a, b) => a.clip.startUs - b.clip.startUs);
  for (const { clip, track } of moved) {
    if (!overlapOn(after, track, clip)) continue;
    track.items = track.items.filter((x) => x !== clip.id);
    let to = after.tracks.find((t) => t.kind === track.kind && t.id !== track.id && !overlapOn(after, t, clip));
    if (!to) {
      to = { id: takeId(after, undefined, "t", opts), kind: track.kind, name: "", muted: false, locked: false, items: [] };
      after.tracks.splice(after.tracks.indexOf(track) + 1, 0, to);
    }
    to.items.push(clip.id);
  }
}

/**
 * A lane other than the main track goes away in the edit that takes its last clip, text or graphic off,
 * so the timeline is just the main track unless something is on top. A lane added empty in an edit is
 * kept (its clip may come in the next one); undo brings a removed lane back with its contents.
 */
function dropEmptiedLanes(before: Project, after: Project): void {
  const had = new Map(before.tracks.map((t) => [t.id, t.items.length]));
  after.tracks = after.tracks.filter((t) => t.kind === "main" || t.items.length > 0 || !had.get(t.id));
}

/**
 * Applies a transaction to a project. All ops succeed or none do. The input
 * project is not modified.
 */
export function applyTransaction(project: Project, tx: Transaction, opts: ApplyOptions): ApplyResult {
  if (!tx || typeof tx.id !== "string" || !tx.id) fail("invalid", "Transaction needs an id");
  if (!Array.isArray(tx.ops) || tx.ops.length === 0) fail("invalid", "Transaction needs at least one op");
  if (tx.by !== "user" && tx.by !== "agent") fail("invalid", 'Transaction "by" must be "user" or "agent"');
  if (tx.baseRevision !== project.revision) {
    fail("stale_revision", `Project is at revision ${project.revision}, transaction was made against ${tx.baseRevision}`, {
      currentRevision: project.revision,
    });
  }
  const draft = clone(project);
  const created: (string | null)[] = [];
  tx.ops.forEach((op, index) => {
    try {
      created.push(applyOp(draft, op, tx.by, opts));
    } catch (err) {
      if (err instanceof EditError) {
        err.message = `op ${index} (${op?.op}): ${err.message}`;
        err.details = { ...err.details, opIndex: index };
      }
      throw err;
    }
  });
  settleLinked(project, draft, opts);
  dropEmptiedLanes(project, draft);
  draft.revision = project.revision + 1;
  return { project: draft, forward: diff(project, draft), inverse: diff(draft, project), created };
}

export type { Item };
