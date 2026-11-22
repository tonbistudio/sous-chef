import { clipDurationUs } from "./compile.js";
import { clone } from "./project.js";
import type { Item, Project, TemplateBody, Us } from "./types.js";

export interface Captured {
  body: TemplateBody;
  /** Media the template's clips use, by project media id. */
  mediaIds: string[];
  lengthUs: Us;
  hasMain: boolean;
  /** A short description of what is in it, e.g. "2 text, 1 graphic". */
  contents: string;
}

/**
 * Copies a stretch of the open timeline into a template: main-track clips
 * that lie wholly inside it, and pictures, video, sound, text, graphics and
 * markers that start inside it. Times become relative to the start. Zooms
 * belong to a recording, not a place in time, so they are left out.
 */
export function captureTemplate(project: Project, fromUs: Us, toUs: Us, name: string): Captured {
  const from = Math.max(0, Math.round(Math.min(fromUs, toUs)));
  const to = Math.round(Math.max(fromUs, toUs));
  if (to - from < 100_000) throw new Error("Choose a stretch of at least a tenth of a second");
  const cut = project.settings.cut;
  const counts = { main: 0, video: 0, picture: 0, audio: 0, text: 0, graphic: 0 };
  const mediaIds = new Set<string>();
  let end = 0;
  const tracks: TemplateBody["tracks"] = [];
  let hasMain = false;
  for (const tr of project.tracks) {
    const items: Item[] = [];
    for (const id of tr.items) {
      const it = project.items[id];
      if (!it) continue;
      if (it.type === "clip") {
        const len = clipDurationUs(it, cut);
        const inside = tr.kind === "main" ? it.startUs >= from && it.startUs + len <= to + 1000 : it.startUs >= from && it.startUs < to;
        if (!inside) continue;
        const copy = clone(it);
        copy.startUs -= from;
        items.push(copy);
        mediaIds.add(it.mediaId);
        end = Math.max(end, copy.startUs + len);
        const media = project.media.find((m) => m.id === it.mediaId);
        if (tr.kind === "main") (counts.main++, (hasMain = true));
        else if (media?.kind === "image") counts.picture++;
        else if (tr.kind === "audio") counts.audio++;
        else counts.video++;
      } else if (it.type === "overlay") {
        if (!(it.startUs >= from && it.startUs < to)) continue;
        const copy = clone(it);
        copy.startUs -= from;
        items.push(copy);
        end = Math.max(end, copy.startUs + copy.durationUs);
        if (it.kind === "text") counts.text++;
        else counts.graphic++;
      }
    }
    if (items.length) tracks.push({ kind: tr.kind, name: tr.name, items });
  }
  // Overlays may sit outside any track list in older projects.
  const listed = new Set(project.tracks.flatMap((t) => t.items));
  const loose = Object.values(project.items).filter((it) => it.type === "overlay" && !listed.has(it.id) && it.startUs >= from && it.startUs < to);
  if (loose.length) {
    const items = loose.map((it) => {
      const copy = clone(it);
      copy.startUs -= from;
      if (copy.type === "overlay") {
        end = Math.max(end, copy.startUs + copy.durationUs);
        if (copy.kind === "text") counts.text++;
        else counts.graphic++;
      }
      return copy;
    });
    tracks.push({ kind: "overlay", name: "Overlays", items });
  }
  const markers = project.markers.filter((m) => m.timeUs >= from && m.timeUs < to).map((m) => ({ ...m, timeUs: m.timeUs - from }));
  if (!tracks.length) throw new Error("Nothing starts in that stretch: no clips, pictures, sound, text or graphics");
  const names: [number, string, string][] = [
    [counts.main, "main clip", "main clips"],
    [counts.video, "video", "videos"],
    [counts.picture, "picture", "pictures"],
    [counts.audio, "sound", "sounds"],
    [counts.text, "text", "texts"],
    [counts.graphic, "graphic", "graphics"],
  ];
  const contents = names.filter(([c]) => c > 0).map(([c, one, many]) => `${c} ${c === 1 ? one : many}`).join(", ");
  return {
    body: { name, mainSpeed: project.settings.mainSpeed || 1, tracks, markers },
    mediaIds: [...mediaIds],
    lengthUs: Math.max(end, 100_000),
    hasMain,
    contents,
  };
}
