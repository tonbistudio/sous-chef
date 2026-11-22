import type { Media, Op } from "@sous-chef/core";
import { baseName, clock } from "./time";
import type { Editor } from "./useEditor";

/** The media item being dragged from the media list, while a drag is on. */
export let draggedMedia: Media | null = null;
export function setDraggedMedia(m: Media | null): void {
  draggedMedia = m;
}

/**
 * Puts a piece of media on the timeline at `at`.
 *
 * `target` is the track it was dropped on, when any. The main track takes
 * videos (later clips move right to make room). Other tracks take what fits
 * them if that stretch is free; otherwise the first free track of the right
 * kind is used, or a new one is made.
 */
export async function placeMedia(editor: Editor, m: Media, at: number, target?: string, mode: "video" | "audio" = m.kind === "audio" ? "audio" : "video"): Promise<void> {
  at = Math.max(0, Math.round(at));
  const name = baseName(m.path);
  if (target === "main" && m.kind === "video") {
    const created = await editor.run(`Add ${name} at ${clock(at)}`, [{ op: "clip.add", trackId: "main", mediaId: m.id, startUs: at }]);
    const clipId = created?.[created.length - 1];
    if (clipId) editor.selectClip(clipId);
    return;
  }
  const kind = mode;
  const len = m.kind === "image" ? 5_000_000 : m.durationUs;
  const busy = (trackId: string) => editor.plan.segments.some((s) => s.trackId === trackId && s.clipEndUs > at && s.clipStartUs < at + len);
  const fits = (id: string | undefined) => {
    const t = id ? editor.project.tracks.find((x) => x.id === id) : undefined;
    return t && t.kind === kind && !busy(t.id) ? t.id : undefined;
  };
  const ops: Op[] = [];
  let trackId = fits(target) ?? editor.project.tracks.find((t) => t.kind === kind && !busy(t.id))?.id;
  if (!trackId) {
    trackId = `${kind[0]}${Date.now().toString(36).slice(-5)}`;
    const count = editor.project.tracks.filter((t) => t.kind === kind).length;
    ops.push({ op: "track.add", kind, id: trackId, name: kind === "audio" ? (count ? `Audio ${count + 1}` : "Music") : count ? `Video ${count + 1}` : "Overlay video" });
  }
  ops.push({ op: "clip.add", trackId, mediaId: m.id, startUs: at });
  const created = await editor.run(`Add ${name} at ${clock(at)}`, ops);
  const clipId = created?.[created.length - 1];
  if (clipId) editor.selectClip(clipId);
}
