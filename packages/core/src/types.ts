/**
 * The Sous Chef project model.
 *
 * Times are integer microseconds. "Source" times count from the start of a
 * media file; "timeline" times count from the start of the finished video.
 */

export const SCHEMA_VERSION = 1;

export type Us = number;

/** x, y, width, height as fractions (0..1) of the source picture. */
export type Rect = [number, number, number, number];

export interface Settings {
  /** Frame size of the timeline being edited; each timeline keeps its own (see StoredTimeline.size). */
  width: number;
  height: number;
  /** How main-track video that is a different shape from the frame is shown: "fill" covers the frame (the sides or top are cut off), "fit" shows all of it with bars. */
  frameFit: "fill" | "fit";
  fps: number;
  cut: { headPadUs: Us; tailPadUs: Us; audioFadeUs: Us };
  zoom: { inUs: Us; outUs: Us; maxScale: number };
  captions: {
    enabled: boolean;
    styleId: string;
    /** Text height as a fraction of the picture height. */
    size: number;
    position: "bottom" | "middle" | "top";
    /** A dark box behind the text instead of an outline. */
    box: boolean;
    uppercase: boolean;
    /** Most words shown at once. */
    maxWords: number;
  };
  /**
   * Playback speed of the main track. Main clips get it when they are added;
   * change it with the project.speed op, which also keeps everything else in step.
   */
  mainSpeed: number;
  audio: {
    /** Bring the finished video to a standard loudness on export. */
    normalize: boolean;
    /** Target loudness in LUFS. -14 is what YouTube plays at. */
    targetLufs: number;
  };
}

export interface MediaProbe {
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  fps?: number;
  videoCodec?: string;
  audioCodec?: string;
  audioChannels?: number;
}

export interface MediaFingerprint {
  size: number;
  mtimeMs: number;
  /** Hash of the first and last megabyte; absent until computed. */
  edgeHash?: string;
}

export interface Media {
  id: string;
  /** Relative to the project folder when inside it, otherwise absolute. */
  path: string;
  kind: "video" | "audio" | "image";
  durationUs: Us;
  probe: MediaProbe;
  fingerprint?: MediaFingerprint;
  /** Path of the immutable word-level transcript, relative to the project folder. */
  transcript?: string;
}

export type TrackKind = "main" | "video" | "audio" | "overlay";

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  muted: boolean;
  locked: boolean;
  /** Item ids. On the main track the order is the play order. */
  items: string[];
}

export type RemovedWhy = "user" | "silence" | "filler" | "retake";
export type Actor = "user" | "agent";

/** A cut inside a clip, in source time. The clip is not split. */
export interface Removed {
  id: string;
  startUs: Us;
  endUs: Us;
  why: RemovedWhy;
  by: Actor;
  /** When true the cut is narrowed by the project's padding so speech keeps breathing room. */
  pad: boolean;
  wordIds?: string[];
}

export interface Transform {
  x: number;
  y: number;
  scale: number;
  opacity: number;
  /** x, y, width, height as fractions of the source picture. */
  crop: Rect;
}

/** How one main-track clip comes in from the one before it. */
export type TransitionKind = "dissolve" | "wipe" | "slide" | "zoom" | "white" | "black";
export const TRANSITION_KINDS: TransitionKind[] = ["dissolve", "wipe", "slide", "zoom", "white", "black"];

export interface Transition {
  kind: TransitionKind;
  /** The whole transition, centred on the cut: half before it, half after. The edit's length does not change. */
  durationUs: Us;
}

export interface Clip {
  id: string;
  type: "clip";
  mediaId: string;
  sourceInUs: Us;
  sourceOutUs: Us;
  /** Timeline position. Ignored on the main track, where order decides. */
  startUs: Us;
  removed: Removed[];
  speed: number;
  volumeDb: number;
  muted: boolean;
  fadeInUs: Us;
  fadeOutUs: Us;
  transform: Transform;
  /** Main track only: how this clip comes in from the clip before it, when they touch. */
  transitionIn?: Transition | null;
}

/**
 * A zoom is pinned to source content: a time range of one media file. It
 * plays wherever that content appears on the main track, so cutting, trimming
 * or splitting clips never detaches it.
 */
export interface Zoom {
  id: string;
  type: "zoom";
  mediaId: string;
  startUs: Us;
  endUs: Us;
  rect: Rect;
  /** null means "use the project default". */
  inUs: Us | null;
  outUs: Us | null;
  maxScale: number | null;
  by: Actor;
}

/** How a text overlay looks. */
export interface TextStyle {
  /** Text height as a fraction of the picture height. */
  size: number;
  /** "#rrggbb" */
  color: string;
  bold: boolean;
  /** A dark box behind the text. */
  box: boolean;
}

/**
 * Something drawn over the picture for a while: plain text, or a HyperFrames
 * composition. It sits on an overlay track at a timeline position. The zoom
 * camera does not move it.
 */
export interface Overlay {
  id: string;
  type: "overlay";
  kind: "text" | "hyperframes";
  startUs: Us;
  durationUs: Us;
  /** Text overlays: the words. HyperFrames overlays: a short label for the timeline. */
  text: string;
  style: TextStyle;
  /** HyperFrames: which template, and the values that fill it in. */
  template?: string;
  params?: Record<string, string>;
  transform: Transform;
  fadeInUs: Us;
  fadeOutUs: Us;
  by: Actor;
}

export type Item = Clip | Zoom | Overlay;

export interface Marker {
  id: string;
  timeUs: Us;
  label: string;
}

export interface Project {
  schemaVersion: number;
  /** Increases by one for every applied transaction, undo and redo. */
  revision: number;
  settings: Settings;
  media: Media[];
  tracks: Track[];
  items: Record<string, Item>;
  markers: Marker[];
  /** Display-text corrections per media and word id. Timing is never changed. */
  wordFixes: Record<string, Record<string, string>>;
  /** Set once main-track clips carry their own start times (they can leave gaps). */
  freeMain?: boolean;
  /** The timeline being edited: `tracks`, `items` and `markers` above are its contents. */
  timelineId?: string;
  timelineName?: string;
  /** Every timeline's id in tab order. */
  timelineOrder?: string[];
  /** The project's other timelines, put away while one is being edited. */
  timelines?: StoredTimeline[];
}

/** A timeline that is not the one being edited. */
/** A reusable piece of a timeline, kept in the template library. Times start at 0. */
export interface TemplateBody {
  name: string;
  /** Main-track speed it was made at; clips are adjusted to the project's speed when it is inserted. */
  mainSpeed: number;
  tracks: { kind: TrackKind; name: string; items: Item[] }[];
  markers: Marker[];
}

export interface StoredTimeline {
  id: string;
  name: string;
  /** Its frame size and fit; absent on timelines saved before timelines had their own size. */
  size?: { width: number; height: number; frameFit?: "fill" | "fit" };
  tracks: Track[];
  items: Record<string, Item>;
  markers: Marker[];
}

// ---------------------------------------------------------------- operations

export type Op =
  | { op: "media.add"; media: Omit<Media, "id"> & { id?: string } }
  | { op: "media.remove"; mediaId: string }
  /** Points a media item at a file that has moved. The new file must be the same recording (same kind and length). */
  | { op: "media.relink"; mediaId: string; media: Partial<Omit<Media, "id">> & { path: string } }
  | { op: "track.add"; kind: Exclude<TrackKind, "main">; name?: string; index?: number; id?: string }
  | { op: "track.remove"; trackId: string }
  | { op: "track.set"; trackId: string; name?: string; muted?: boolean; locked?: boolean }
  | {
      op: "clip.add";
      trackId: string;
      mediaId: string;
      sourceInUs?: Us;
      sourceOutUs?: Us;
      /** Main track: position in the play order (default: end). */
      index?: number;
      /** Other tracks: timeline position. */
      startUs?: Us;
      id?: string;
    }
  | { op: "clip.remove"; clipId: string }
  | { op: "clip.move"; clipId: string; index?: number; startUs?: Us; trackId?: string }
  | { op: "clip.trim"; clipId: string; sourceInUs?: Us; sourceOutUs?: Us }
  | { op: "clip.split"; clipId: string; atSourceUs: Us; newId?: string }
  | {
      op: "clip.set";
      clipId: string;
      speed?: number;
      volumeDb?: number;
      muted?: boolean;
      fadeInUs?: Us;
      fadeOutUs?: Us;
      transform?: Partial<Transform>;
      /** Main-track clips: the transition from the clip before; null removes it. */
      transitionIn?: Transition | null;
    }
  | {
      op: "range.remove";
      clipId: string;
      startUs: Us;
      endUs: Us;
      why?: RemovedWhy;
      pad?: boolean;
      wordIds?: string[];
      id?: string;
    }
  | { op: "range.restore"; clipId: string; rangeIds: string[] }
  | {
      op: "zoom.add";
      mediaId: string;
      startUs: Us;
      endUs: Us;
      rect: Rect;
      inUs?: Us | null;
      outUs?: Us | null;
      maxScale?: number | null;
      id?: string;
    }
  | {
      op: "zoom.set";
      zoomId: string;
      startUs?: Us;
      endUs?: Us;
      rect?: Rect;
      inUs?: Us | null;
      outUs?: Us | null;
      maxScale?: number | null;
    }
  | { op: "zoom.remove"; zoomId: string }
  | {
      op: "overlay.add";
      kind: Overlay["kind"];
      startUs: Us;
      durationUs: Us;
      text?: string;
      style?: Partial<TextStyle>;
      template?: string;
      params?: Record<string, string>;
      transform?: Partial<Transform>;
      fadeInUs?: Us;
      fadeOutUs?: Us;
      /** Which overlay track. Omit to use the first one, creating it if needed. */
      trackId?: string;
      id?: string;
    }
  | {
      op: "overlay.set";
      overlayId: string;
      startUs?: Us;
      durationUs?: Us;
      text?: string;
      style?: Partial<TextStyle>;
      params?: Record<string, string>;
      transform?: Partial<Transform>;
      fadeInUs?: Us;
      fadeOutUs?: Us;
    }
  | { op: "overlay.remove"; overlayId: string }
  /** Corrects how a transcript word is shown. text null removes the correction. Timing never changes. */
  | { op: "word.fix"; mediaId: string; wordId: string; text: string | null }
  /** Closes empty space on the main track: the gap at a time, or every gap when no time is given. */
  | { op: "gap.close"; atUs?: Us }
  | { op: "timeline.add"; name?: string; id?: string; width?: number; height?: number }
  /** Sets the frame size of the timeline being edited (16:9 1920x1080, 9:16 1080x1920, 1:1 1080x1080, 4:5 1080x1350...). */
  | { op: "timeline.size"; width: number; height: number; frameFit?: "fill" | "fit" }
  | { op: "timeline.switch"; timelineId: string }
  | { op: "timeline.rename"; timelineId: string; name: string }
  | { op: "timeline.remove"; timelineId: string }
  /** Copies everything in another timeline into the one being edited, at a time (the end when omitted). Later content moves right to make room. */
  | { op: "timeline.insert"; timelineId: string; atUs?: Us }
  | { op: "marker.add"; timeUs: Us; label?: string; id?: string }
  | { op: "marker.remove"; markerId: string }
  | { op: "marker.update"; markerId: string; label?: string; timeUs?: Us }
  | { op: "settings.set"; settings: DeepPartial<Settings> }
  /** Speeds the whole main track up or down; text, pictures, music and markers move with it. */
  | { op: "project.speed"; speed: number }
  /** Drops a template's pieces in at a time. With main-track clips in it, later content moves right to make room. */
  | { op: "template.insert"; template: TemplateBody; atUs?: Us };

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface Transaction {
  /** Repeating an id that was already applied is a no-op. */
  id: string;
  /** The revision the sender last saw. A stale value is rejected. */
  baseRevision: number;
  by: Actor;
  summary: string;
  ops: Op[];
  /** For agent transactions: the instruction that produced it. */
  instruction?: string;
}

/** A reversible description of what a transaction changed. */
export interface Patch {
  /** Path ("settings", "tracks", "items/c1", ...) to its new value. */
  set: Record<string, unknown>;
  /** Item paths that no longer exist. */
  del: string[];
}

export type EditErrorCode = "stale_revision" | "not_found" | "invalid" | "conflict";

export class EditError extends Error {
  constructor(
    public code: EditErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "EditError";
  }
}
