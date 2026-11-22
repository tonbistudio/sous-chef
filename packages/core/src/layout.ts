import { clipDurationUs } from "./compile.js";
import type { Clip, Project, Track } from "./types.js";

export function mainTrack(p: Project): Track {
  return p.tracks.find((t) => t.kind === "main")!;
}

export function mainClipsOf(p: Project): Clip[] {
  return mainTrack(p)
    .items.map((id) => p.items[id])
    .filter((c): c is Clip => c?.type === "clip");
}

/**
 * Puts the main track in order: clips sorted by start, none overlapping (a
 * clip that would overlap the one before it is pushed right, and so on down
 * the line). Empty space between clips is left alone. Changes the project in
 * place.
 */
export function settleMain(p: Project): void {
  const track = mainTrack(p);
  if (!track) return;
  const clips = mainClipsOf(p);
  // Stable: clips with the same start keep their order in the list.
  const order = clips.map((c, i) => ({ c, i })).sort((a, b) => a.c.startUs - b.c.startUs || a.i - b.i);
  let cursor = 0;
  for (const { c } of order) {
    if (c.startUs < cursor) c.startUs = cursor;
    cursor = c.startUs + clipDurationUs(c, p.settings.cut);
  }
  track.items = order.map((o) => o.c.id);
}

/** Where the main track ends. */
export function mainEndUs(p: Project): number {
  return mainClipsOf(p).reduce((m, c) => Math.max(m, c.startUs + clipDurationUs(c, p.settings.cut)), 0);
}

/**
 * Brings a project made by an older version up to date: main clips get start
 * times (laid end to end, as they played before) and the timeline gets a name.
 * Changes the project in place.
 */
export function upgradeProject(p: Project): Project {
  if (!p.freeMain) {
    for (const c of mainClipsOf(p)) c.startUs = 0;
    settleMain(p);
    p.freeMain = true;
  }
  p.timelineId ??= "tl1";
  p.timelineName ??= "Timeline 1";
  p.timelines ??= [];
  p.timelineOrder ??= [p.timelineId, ...p.timelines.map((t) => t.id)];
  return p;
}
