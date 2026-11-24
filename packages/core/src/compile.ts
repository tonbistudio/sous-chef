import type { Clip, Overlay, Project, Rect, Settings, TextStyle, Transform, Transition, Us, Zoom } from "./types.js";

/** One continuous stretch of one media file placed on the timeline. */
export interface Segment {
  trackId: string;
  trackKind: "main" | "video" | "audio";
  clipId: string;
  mediaId: string;
  srcInUs: Us;
  srcOutUs: Us;
  tlStartUs: Us;
  tlEndUs: Us;
  speed: number;
  hasVideo: boolean;
  hasAudio: boolean;
  volumeDb: number;
  muted: boolean;
  /** True when this segment starts right after a cut inside its clip. */
  afterCut: boolean;
  /** A still picture: it has no time of its own. */
  still: boolean;
  /** Where the whole clip sits on the timeline; fades are measured from these. */
  clipStartUs: Us;
  clipEndUs: Us;
  fadeInUs: Us;
  fadeOutUs: Us;
  /** Placement on screen. Ignored on the main track, which always fills the picture. */
  transform: Transform;
  /** Width over height of the source picture, when known. */
  aspect?: number;
  /**
   * Main track, first piece of a clip that touches the piece before it: how it comes in. The length is
   * already limited so each side has enough of its own piece (half the transition each side of the cut).
   */
  transitionIn?: Transition;
}

/** A text or HyperFrames overlay placed on the timeline. */
export interface OverlaySpan {
  id: string;
  kind: Overlay["kind"];
  tlStartUs: Us;
  tlEndUs: Us;
  text: string;
  style: TextStyle;
  template?: string;
  params?: Record<string, string>;
  transform: Transform;
  fadeInUs: Us;
  fadeOutUs: Us;
}

/** A zoom mapped onto the timeline. */
export interface CameraSpan {
  zoomId: string;
  tlStartUs: Us;
  tlEndUs: Us;
  rect: Rect;
  inUs: Us;
  outUs: Us;
  maxScale: number;
}

export interface Plan {
  revision: number;
  durationUs: Us;
  fps: number;
  width: number;
  height: number;
  segments: Segment[];
  camera: CameraSpan[];
  overlays: OverlaySpan[];
  audioFadeUs: Us;
}

const MIN_KEEP_US = 1_000;

/**
 * The source ranges of a clip that actually play: its range minus the removed
 * ranges. Padded removals are narrowed so speech keeps breathing room.
 */
export function keptRanges(clip: Clip, cut: Settings["cut"]): [Us, Us][] {
  const holes: [Us, Us][] = [];
  for (const r of clip.removed) {
    let s = r.startUs;
    let e = r.endUs;
    if (r.pad) {
      // Leave the tail after the last kept word and the head before the next one,
      // except at the clip's own edges where there is nothing to protect.
      if (s > clip.sourceInUs) s += cut.tailPadUs;
      if (e < clip.sourceOutUs) e -= cut.headPadUs;
    }
    s = Math.max(s, clip.sourceInUs);
    e = Math.min(e, clip.sourceOutUs);
    if (e > s) holes.push([s, e]);
  }
  holes.sort((a, b) => a[0] - b[0]);
  const kept: [Us, Us][] = [];
  let cursor = clip.sourceInUs;
  for (const [s, e] of holes) {
    if (s - cursor >= MIN_KEEP_US) kept.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (clip.sourceOutUs - cursor >= MIN_KEEP_US) kept.push([cursor, clip.sourceOutUs]);
  return kept;
}

/** Timeline length of a clip after its cuts and speed. */
export function clipDurationUs(clip: Clip, cut: Settings["cut"]): Us {
  let total = 0;
  for (const [s, e] of keptRanges(clip, cut)) total += Math.round((e - s) / clip.speed);
  return total;
}

/** How much bigger than "fits inside" a picture of this shape must be to cover the whole frame. */
export function coverScale(aspect: number | undefined, frameAspect: number): number {
  if (!aspect || !(aspect > 0) || !(frameAspect > 0)) return 1;
  const r = aspect / frameAspect;
  return Math.max(r, 1 / r);
}

/** A transform nobody has moved, resized or cropped. */
export function isPlainTransform(t: Transform | undefined): boolean {
  return !t || (Math.abs(t.x) < 1e-4 && Math.abs(t.y) < 1e-4 && Math.abs(t.scale - 1) < 1e-4 && t.crop[0] < 1e-4 && t.crop[1] < 1e-4 && t.crop[2] > 0.9999 && t.crop[3] > 0.9999);
}

/**
 * Where a main-track clip is shown. On a timeline set to fill, a clip that has not been moved, resized or
 * cropped is scaled up to cover the frame when its shape differs (a wide recording on a tall timeline).
 */
export function mainTransform(t: Transform, aspect: number | undefined, settings: Settings): Transform {
  if (settings.frameFit !== "fill" || !isPlainTransform(t)) return t;
  const s = coverScale(aspect, settings.width / settings.height);
  return Math.abs(s - 1) < 1e-4 ? t : { ...t, scale: s };
}

/** Turns a project into the flat plan that both preview and export read. */
export function compile(project: Project): Plan {
  const { settings } = project;
  const mediaById = new Map(project.media.map((m) => [m.id, m]));
  const segments: Segment[] = [];
  let durationUs = 0;

  for (const track of project.tracks) {
    if (track.kind === "overlay") continue;
    let cursor = 0;
    for (const id of track.items) {
      const clip = project.items[id];
      if (!clip || clip.type !== "clip") continue;
      const media = mediaById.get(clip.mediaId);
      if (!media) continue;
      // Projects from before clips had their own start on the main track play end to end.
      let t = track.kind === "main" && !project.freeMain ? cursor : clip.startUs;
      let first = true;
      const clipStartUs = t;
      const clipEndUs = t + clipDurationUs(clip, settings.cut);
      for (const [s, e] of keptRanges(clip, settings.cut)) {
        const len = Math.round((e - s) / clip.speed);
        segments.push({
          trackId: track.id,
          trackKind: track.kind,
          clipId: clip.id,
          mediaId: clip.mediaId,
          srcInUs: s,
          srcOutUs: e,
          tlStartUs: t,
          tlEndUs: t + len,
          speed: clip.speed,
          hasVideo: track.kind !== "audio" && (media.probe.hasVideo || media.kind === "image"),
          hasAudio: media.probe.hasAudio && media.kind !== "image",
          volumeDb: clip.volumeDb,
          muted: clip.muted || track.muted,
          afterCut: !first,
          still: media.kind === "image",
          clipStartUs,
          clipEndUs,
          fadeInUs: Math.min(clip.fadeInUs, clipEndUs - clipStartUs),
          fadeOutUs: Math.min(clip.fadeOutUs, clipEndUs - clipStartUs),
          transform: track.kind === "main" && media.kind !== "image" ? mainTransform(clip.transform, media.probe.width && media.probe.height ? media.probe.width / media.probe.height : undefined, settings) : clip.transform,
          ...(media.probe.width && media.probe.height ? { aspect: media.probe.width / media.probe.height } : {}),
        });
        t += len;
        first = false;
      }
      if (track.kind === "main") cursor = t;
      durationUs = Math.max(durationUs, t);
    }
  }

  // Text and graphics count toward the length too, so a project can start with no video at all
  // (a title card, a voiceover over black) and the picture is black where nothing else plays.
  for (const track of project.tracks) {
    if (track.kind !== "overlay" || track.muted) continue;
    for (const id of track.items) {
      const o = project.items[id];
      if (o && o.type === "overlay") durationUs = Math.max(durationUs, o.startUs + o.durationUs);
    }
  }

  // Transitions: a main clip's first piece that starts exactly where the piece before it ends.
  const main = segments.filter((sg) => sg.trackKind === "main").sort((a, b) => a.tlStartUs - b.tlStartUs);
  for (let k = 1; k < main.length; k++) {
    const sg = main[k]!;
    const prev = main[k - 1]!;
    if (sg.afterCut || Math.abs(prev.tlEndUs - sg.tlStartUs) > 1000) continue;
    const clip = project.items[sg.clipId];
    const t = clip && clip.type === "clip" ? clip.transitionIn : null;
    if (!t) continue;
    // Half each side of the cut, and never more than half of either piece.
    const half = Math.min(t.durationUs / 2, (prev.tlEndUs - prev.tlStartUs) / 2, (sg.tlEndUs - sg.tlStartUs) / 2);
    if (half < 40_000) continue;
    sg.transitionIn = { kind: t.kind, durationUs: Math.round(half * 2) };
  }

  const camera = compileCamera(project, segments);
  const overlays: OverlaySpan[] = [];
  for (const track of project.tracks) {
    if (track.kind !== "overlay" || track.muted) continue;
    for (const id of track.items) {
      const o = project.items[id];
      if (!o || o.type !== "overlay" || o.startUs >= durationUs) continue;
      const end = Math.min(durationUs, o.startUs + o.durationUs);
      overlays.push({
        id: o.id,
        kind: o.kind,
        tlStartUs: o.startUs,
        tlEndUs: end,
        text: o.text,
        style: o.style,
        ...(o.template ? { template: o.template } : {}),
        ...(o.params ? { params: o.params } : {}),
        transform: o.transform,
        fadeInUs: Math.min(o.fadeInUs, end - o.startUs),
        fadeOutUs: Math.min(o.fadeOutUs, end - o.startUs),
      });
    }
  }
  overlays.sort((a, b) => a.tlStartUs - b.tlStartUs);
  return {
    revision: project.revision,
    durationUs,
    fps: settings.fps,
    width: settings.width,
    height: settings.height,
    segments,
    camera,
    overlays,
    audioFadeUs: settings.cut.audioFadeUs,
  };
}

function compileCamera(project: Project, segments: Segment[]): CameraSpan[] {
  const zooms = Object.values(project.items).filter((i): i is Zoom => i.type === "zoom");
  const main = segments.filter((s) => s.trackKind === "main");
  const spans: CameraSpan[] = [];
  for (const zoom of zooms) {
    let open: CameraSpan | null = null;
    for (const seg of main) {
      if (seg.mediaId !== zoom.mediaId) {
        open = null;
        continue;
      }
      const s = Math.max(seg.srcInUs, zoom.startUs);
      const e = Math.min(seg.srcOutUs, zoom.endUs);
      if (e <= s) {
        open = null;
        continue;
      }
      const tlStartUs = seg.tlStartUs + Math.round((s - seg.srcInUs) / seg.speed);
      const tlEndUs = seg.tlStartUs + Math.round((e - seg.srcInUs) / seg.speed);
      // A cut inside the zoom closes the gap on the timeline, so the pieces join.
      if (open && open.tlEndUs === tlStartUs) {
        open.tlEndUs = tlEndUs;
      } else {
        open = {
          zoomId: zoom.id,
          tlStartUs,
          tlEndUs,
          rect: zoom.rect,
          inUs: zoom.inUs ?? project.settings.zoom.inUs,
          outUs: zoom.outUs ?? project.settings.zoom.outUs,
          maxScale: zoom.maxScale ?? project.settings.zoom.maxScale,
        };
        spans.push(open);
      }
    }
  }
  spans.sort((a, b) => a.tlStartUs - b.tlStartUs);
  return spans;
}

/** Where a moment of one clip's source plays on the timeline, on any track, or null if it was cut. */
export function clipSourceToTimeline(plan: Plan, clipId: string, srcUs: Us): Us | null {
  for (const seg of plan.segments) {
    if (seg.clipId !== clipId) continue;
    if (srcUs >= seg.srcInUs && srcUs < seg.srcOutUs) return seg.tlStartUs + Math.round((srcUs - seg.srcInUs) / seg.speed);
  }
  return null;
}

/** Where a moment of a media file plays on the main track, or null if it was cut. */
export function sourceToTimeline(plan: Plan, mediaId: string, srcUs: Us): Us | null {
  for (const seg of plan.segments) {
    if (seg.trackKind !== "main" || seg.mediaId !== mediaId) continue;
    if (srcUs >= seg.srcInUs && srcUs < seg.srcOutUs) {
      return seg.tlStartUs + Math.round((srcUs - seg.srcInUs) / seg.speed);
    }
  }
  return null;
}

/** The main-track segment playing at a timeline time, with the matching source time. */
export function timelineToSource(plan: Plan, tlUs: Us): { segment: Segment; srcUs: Us } | null {
  for (const seg of plan.segments) {
    if (seg.trackKind !== "main") continue;
    if (tlUs >= seg.tlStartUs && tlUs < seg.tlEndUs) {
      return { segment: seg, srcUs: seg.srcInUs + Math.round((tlUs - seg.tlStartUs) * seg.speed) };
    }
  }
  return null;
}

/** Nearest frame boundary, for callers that need whole frames. */
export function snapToFrame(us: Us, fps: number): Us {
  return Math.round(Math.round((us * fps) / 1_000_000) * (1_000_000 / fps));
}

/**
 * The part of a plan between two timeline times, re-based to start at zero.
 * Used to export a range. The camera keeps its motion: a zoom that began
 * before the range is already under way when the range starts.
 */
export function slicePlan(plan: Plan, fromUs: Us, toUs: Us): Plan {
  const a = Math.max(0, Math.min(fromUs, toUs));
  const b = Math.min(plan.durationUs, Math.max(fromUs, toUs));
  const segments: Segment[] = [];
  for (const seg of plan.segments) {
    const s = Math.max(seg.tlStartUs, a);
    const e = Math.min(seg.tlEndUs, b);
    if (e - s < MIN_KEEP_US) continue;
    segments.push({
      ...seg,
      tlStartUs: s - a,
      tlEndUs: e - a,
      srcInUs: seg.still ? seg.srcInUs : seg.srcInUs + Math.round((s - seg.tlStartUs) * seg.speed),
      srcOutUs: seg.still ? seg.srcOutUs : seg.srcInUs + Math.round((e - seg.tlStartUs) * seg.speed),
      clipStartUs: seg.clipStartUs - a,
      clipEndUs: seg.clipEndUs - a,
    });
  }
  return {
    ...plan,
    durationUs: Math.max(0, b - a),
    segments,
    camera: plan.camera.map((c) => ({ ...c, tlStartUs: c.tlStartUs - a, tlEndUs: c.tlEndUs - a })),
    overlays: plan.overlays.filter((o) => o.tlEndUs > a && o.tlStartUs < b).map((o) => ({ ...o, tlStartUs: o.tlStartUs - a, tlEndUs: Math.min(o.tlEndUs, b) - a })),
  };
}

/** A rectangle on screen as fractions of the picture: left, top, width, height. */
export type Box = [number, number, number, number];

/**
 * Where a placed picture or video sits on screen. `full` is the whole source
 * fitted inside its box; `visible` is what is left of it after cropping.
 * Cropping trims the edges and leaves the rest where it was, at the same size.
 */
export function layerBoxes(t: Transform, aspect: number | undefined, stageAspect: number): { full: Box; visible: Box } {
  const r = (aspect && aspect > 0 ? aspect : stageAspect) / stageAspect;
  const fw = r >= 1 ? t.scale : t.scale * r;
  const fh = r >= 1 ? t.scale / r : t.scale;
  const full: Box = [0.5 + t.x - fw / 2, 0.5 + t.y - fh / 2, fw, fh];
  const [cx, cy, cw, ch] = t.crop;
  return { full, visible: [full[0] + cx * fw, full[1] + cy * fh, cw * fw, ch * fh] };
}
