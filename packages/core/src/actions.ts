/** Edits described in timeline time, turned into ops on clips. Shared by the editor and the agent tools. */
import { timelineToSource, type Plan } from "./compile.js";
import type { Op, Project } from "./types.js";

/** Ops that cut a stretch of the timeline out of every main clip it touches. */
export function cutRangeOps(plan: Plan, tlA: number, tlB: number): Op[] {
  const a = Math.min(tlA, tlB);
  const b = Math.max(tlA, tlB);
  const perClip = new Map<string, { startUs: number; endUs: number }>();
  for (const seg of plan.segments) {
    if (seg.trackKind !== "main") continue;
    const s = Math.max(a, seg.tlStartUs);
    const e = Math.min(b, seg.tlEndUs);
    if (e <= s) continue;
    const srcS = seg.srcInUs + Math.round((s - seg.tlStartUs) * seg.speed);
    const srcE = seg.srcInUs + Math.round((e - seg.tlStartUs) * seg.speed);
    const cur = perClip.get(seg.clipId);
    // Segments of one clip are in source order, so the union is first start to last end.
    if (cur) cur.endUs = srcE;
    else perClip.set(seg.clipId, { startUs: srcS, endUs: srcE });
  }
  return [...perClip].map(([clipId, r]) => ({ op: "range.remove" as const, clipId, startUs: r.startUs, endUs: r.endUs }));
}

/** The op that splits whichever main clip is under a timeline time, or null at a clip edge. */
export function splitAtOp(plan: Plan, tlUs: number): Op | null {
  const hit = timelineToSource(plan, tlUs);
  if (!hit) return null;
  const { segment, srcUs } = hit;
  if (srcUs - segment.srcInUs < 1000 && !segment.afterCut) return null;
  return { op: "clip.split", clipId: segment.clipId, atSourceUs: srcUs };
}

/**
 * The ops that split clips at a timeline time. With a selected clip under the playhead, just that clip;
 * otherwise every clip there: the main track and the video and audio lanes (voiceovers, music, B-roll).
 * Lanes that are locked are left alone, and so is a clip whose edge is at that time.
 */
export function splitClipsAtOps(plan: Plan, project: Project, tlUs: number, selectedId?: string | null): Op[] {
  const locked = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id));
  const ops = new Map<string, Op>();
  for (const seg of plan.segments) {
    if (locked.has(seg.trackId) || ops.has(seg.clipId)) continue;
    if (tlUs < seg.tlStartUs || tlUs >= seg.tlEndUs) continue;
    if (seg.trackKind === "main") {
      const op = splitAtOp(plan, tlUs);
      if (op) ops.set(seg.clipId, op);
      continue;
    }
    const clip = project.items[seg.clipId];
    if (!clip || clip.type !== "clip") continue;
    const at = seg.srcInUs + Math.round((tlUs - seg.tlStartUs) * seg.speed);
    if (at - clip.sourceInUs < 20_000 || clip.sourceOutUs - at < 20_000) continue;
    ops.set(seg.clipId, { op: "clip.split", clipId: seg.clipId, atSourceUs: at });
  }
  if (selectedId && ops.has(selectedId)) return [ops.get(selectedId)!];
  return [...ops.values()];
}

/** Timeline start and end of each main clip. */
export function clipSpans(plan: Plan): Map<string, { startUs: number; endUs: number; cuts: number[] }> {
  const spans = new Map<string, { startUs: number; endUs: number; cuts: number[] }>();
  for (const seg of plan.segments) {
    if (seg.trackKind !== "main") continue;
    const cur = spans.get(seg.clipId);
    if (!cur) spans.set(seg.clipId, { startUs: seg.tlStartUs, endUs: seg.tlEndUs, cuts: [] });
    else {
      cur.cuts.push(seg.tlStartUs);
      cur.endUs = seg.tlEndUs;
    }
  }
  return spans;
}
