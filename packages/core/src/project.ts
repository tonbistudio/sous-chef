import { settleMain } from "./layout.js";
import { SCHEMA_VERSION, type Patch, type Project, type Settings, type Transform } from "./types.js";

export function defaultSettings(): Settings {
  return {
    width: 1920,
    height: 1080,
    frameFit: "fill",
    fps: 60,
    cut: { headPadUs: 100_000, tailPadUs: 100_000, audioFadeUs: 10_000 },
    zoom: { inUs: 1_500_000, outUs: 1_500_000, maxScale: 2.0 },
    captions: { enabled: false, styleId: "default", size: 0.05, position: "bottom", box: true, uppercase: false, maxWords: 8 },
    mainSpeed: 1,
    audio: { normalize: false, targetLufs: -14 },
  };
}

/** Fills in settings that did not exist when a project was made. Changes the project in place. */
export function fillSettings(project: Project): Project {
  const d = defaultSettings() as unknown as Record<string, unknown>;
  const s = project.settings as unknown as Record<string, unknown>;
  // Projects from before "fill" showed every recording whole, with bars; they keep doing that.
  if (!("frameFit" in s)) s.frameFit = "fit";
  for (const [key, value] of Object.entries(d)) {
    if (!(key in s)) s[key] = value;
    else if (value && typeof value === "object") {
      const group = s[key] as Record<string, unknown>;
      for (const [k2, v2] of Object.entries(value)) if (!(k2 in group)) group[k2] = v2;
    }
  }
  return project;
}

export function defaultTransform(): Transform {
  return { x: 0, y: 0, scale: 1, opacity: 1, crop: [0, 0, 1, 1] };
}

/** A new project with its one main track. `mainSpeed` is the owner's usual speed for new work. */
export function createProject(defaults: { mainSpeed?: number; levelLufs?: number | null } = {}): Project {
  const settings = defaultSettings();
  if (defaults.mainSpeed && defaults.mainSpeed >= 0.25 && defaults.mainSpeed <= 4) settings.mainSpeed = defaults.mainSpeed;
  if (typeof defaults.levelLufs === "number" && defaults.levelLufs >= -30 && defaults.levelLufs <= -8) settings.audio = { normalize: true, targetLufs: defaults.levelLufs };
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    settings,
    media: [],
    tracks: [{ id: "main", kind: "main", name: "Main", muted: false, locked: false, items: [] }],
    items: {},
    markers: [],
    wordFixes: {},
    freeMain: true,
    timelineId: "tl1",
    timelineName: "Timeline 1",
    timelineOrder: ["tl1"],
    timelines: [],
  };
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const WHOLE_KEYS = ["settings", "media", "tracks", "markers", "wordFixes", "freeMain", "timelineId", "timelineName", "timelineOrder", "timelines"] as const;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The patch that turns `before` into `after`. Revision is not part of a patch. */
export function diff(before: Project, after: Project): Patch {
  const patch: Patch = { set: {}, del: [] };
  for (const key of WHOLE_KEYS) {
    if (!same(before[key], after[key])) patch.set[key] = clone(after[key] ?? null);
  }
  for (const id of Object.keys(after.items)) {
    if (!same(before.items[id], after.items[id])) patch.set[`items/${id}`] = clone(after.items[id]);
  }
  for (const id of Object.keys(before.items)) {
    if (!(id in after.items)) patch.del.push(`items/${id}`);
  }
  return patch;
}

/** Applies a patch and bumps the revision. Returns a new project. */
export function applyPatch(project: Project, patch: Patch): Project {
  const next = clone(project);
  for (const [path, value] of Object.entries(patch.set)) {
    if (path.startsWith("items/")) {
      next.items[path.slice(6)] = clone(value) as Project["items"][string];
    } else {
      (next as unknown as Record<string, unknown>)[path] = clone(value);
    }
  }
  for (const path of patch.del) {
    if (path.startsWith("items/")) delete next.items[path.slice(6)];
  }
  // Undoing a change from before clips had their own start times can leave them stacked; lay them out again.
  if (next.freeMain) settleMain(next);
  next.revision = project.revision + 1;
  return next;
}

export function isEmptyPatch(patch: Patch): boolean {
  return Object.keys(patch.set).length === 0 && patch.del.length === 0;
}
