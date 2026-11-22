import type { Op, Transition, TransitionKind } from "@sous-chef/core";
import type { Editor } from "./useEditor";

export const TRANSITION_NAMES: Record<TransitionKind, string> = {
  dissolve: "Dissolve",
  wipe: "Wipe",
  slide: "Slide",
  zoom: "Zoom through",
  white: "Dip to white",
  black: "Dip to black",
};

export const TRANSITION_HINTS: Record<TransitionKind, string> = {
  dissolve: "One picture fades into the next",
  wipe: "The next picture sweeps in across",
  slide: "The next picture pushes the last one off",
  zoom: "Pushes into the old picture as the new one appears",
  white: "A quick flash of white at the cut",
  black: "Fades through black",
};

/** A join on the main track where a transition can go. */
export interface Cut {
  atUs: number;
  /** The clip the later piece belongs to. */
  clipId: string;
  /** Inside one clip, where a stretch was cut out: the clip is split here to take a transition. */
  inside: boolean;
  /** Where the later piece starts in its recording (the split point for a cut inside a clip). */
  srcInUs: number;
  /** The transition on it now. */
  transition: Transition | null;
  /** The shorter of the two pieces either side, which limits how long a transition can be. */
  roomUs: number;
}

/** Every cut on the main track: between clips that touch, and inside clips where something was cut out. */
export function transitionCuts(editor: Editor): Cut[] {
  const main = editor.plan.segments.filter((sg) => sg.trackKind === "main").sort((a, b) => a.tlStartUs - b.tlStartUs);
  const out: Cut[] = [];
  for (let i = 1; i < main.length; i++) {
    const sg = main[i]!;
    const prev = main[i - 1]!;
    if (Math.abs(prev.tlEndUs - sg.tlStartUs) >= 1000) continue;
    out.push({
      atUs: sg.tlStartUs,
      clipId: sg.clipId,
      inside: sg.afterCut,
      srcInUs: sg.srcInUs,
      transition: sg.afterCut ? null : (sg.transitionIn ?? null),
      roomUs: Math.min(sg.tlEndUs - sg.tlStartUs, prev.tlEndUs - prev.tlStartUs),
    });
  }
  return out;
}

/** Usual length for a kind of transition. */
export function defaultLength(kind: TransitionKind): number {
  return kind === "white" || kind === "black" ? 600_000 : 800_000;
}

/**
 * The edit that puts a transition on a cut (or takes it off, with null). A cut inside a clip is first made a
 * cut between two clips, by splitting the clip where the later piece starts; the picture does not change.
 */
export function transitionOps(cut: Cut, t: Transition | null): Op[] {
  if (!cut.inside) return [{ op: "clip.set", clipId: cut.clipId, transitionIn: t }];
  if (!t) return [];
  const newId = `c${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  return [
    { op: "clip.split", clipId: cut.clipId, atSourceUs: cut.srcInUs, newId } as Op,
    { op: "clip.set", clipId: newId, transitionIn: t },
  ];
}

export function label(kind: TransitionKind | null, atUs: number, clock: (us: number) => string): string {
  return kind ? `${TRANSITION_NAMES[kind]} at ${clock(atUs)}` : `Remove transition at ${clock(atUs)}`;
}
