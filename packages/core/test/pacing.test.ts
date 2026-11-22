import { describe, expect, it } from "vitest";
import { applyTransaction, compile, createProject, pacing, type Op, type Project, type Transcript } from "../src/index";

const S = 1_000_000;
let n = 0;
function apply(p: Project, ops: Op[]): Project {
  return applyTransaction(p, { id: `t${++n}`, baseRevision: p.revision, by: "user", summary: "", ops }, { newId: (x) => `${x}${++n}` }).project;
}

/** Words are 0.3 s long, 0.1 s apart; "|2" inserts a pause of that many seconds. */
function speak(text: string): Transcript {
  let t = 0.5 * S;
  const words = [];
  for (const tok of text.split(/\s+/)) {
    if (tok.startsWith("|")) {
      t += Number(tok.slice(1)) * S - 0.1 * S;
      continue;
    }
    words.push({ id: `w${words.length}`, text: tok, startUs: t, endUs: t + 0.3 * S });
    t += 0.4 * S;
  }
  return { schema: 1, engine: "test", model: "test", words, silences: [] };
}

function project(t: Transcript): Project {
  const len = Math.round(t.words[t.words.length - 1]!.endUs + 0.3 * S);
  return apply(createProject(), [
    { op: "media.add", media: { id: "m1", path: "a.mp4", kind: "video", durationUs: len, probe: { hasVideo: true, hasAudio: true } } as never },
    { op: "clip.add", trackId: "main", mediaId: "m1", id: "c1" },
  ]);
}

describe("pacing", () => {
  it("lists the long pauses heard in the edit and tightening shortens the video by what it says", () => {
    const t = speak("one two three |0.8 four five |2.5 six seven |3 eight nine");
    const p = project(t);
    const r = pacing(p, { m1: t }, { longUs: 1 * S, keepUs: 0.5 * S });
    expect(r.pauses.map((x) => Math.round(x.heardUs / 1e5) / 10)).toEqual([2.5, 3]);
    expect(r.tighten).toHaveLength(2);
    const before = compile(p).durationUs;
    const after = compile(apply(p, r.tighten.flatMap((s) => s.ops))).durationUs;
    expect(before - after).toBe(r.tightenSavesUs);
    // Each pause is left at about half a second.
    expect(r.tightenSavesUs).toBeGreaterThan(4.3 * S);
    expect(r.tightenSavesUs).toBeLessThan(4.6 * S);
    // Once tightened there is nothing long left.
    const again = pacing(apply(p, r.tighten.flatMap((s) => s.ops)), { m1: t }, { longUs: 1 * S, keepUs: 0.5 * S });
    expect(again.pauses).toHaveLength(0);
    expect(again.tighten).toHaveLength(0);
  });

  it("measures pauses in edit time when the main track is sped up", () => {
    const t = speak("one two |2 three four");
    const p = apply(project(t), [{ op: "project.speed", speed: 2 } as never]);
    const r = pacing(p, { m1: t }, { longUs: 0.5 * S });
    expect(r.pauses).toHaveLength(1);
    expect(Math.round(r.pauses[0]!.heardUs / 1e5) / 10).toBe(1);
    // Tightening leaves what is asked for as heard: about 0.25 s of the 1 s heard pause stays.
    const tight = pacing(p, { m1: t }, { longUs: 0.5 * S, keepUs: 0.25 * S });
    expect(tight.tightenSavesUs).toBeGreaterThan(0.7 * S);
    expect(tight.tightenSavesUs).toBeLessThan(0.8 * S);
  });

  it("marks a stretch with little said as slow", () => {
    const fast = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
    const t = speak(`${fast} |20 a b c ${fast}`);
    const r = pacing(project(t), { m1: t }, { windowUs: 10 * S });
    expect(r.medianWpm).toBeGreaterThan(100);
    const slow = r.windows.filter((w) => w.slow);
    expect(slow.length).toBeGreaterThan(0);
    expect(slow.every((w) => w.tlStartUs >= 20 * S && w.tlStartUs < 50 * S)).toBe(true);
  });
});
