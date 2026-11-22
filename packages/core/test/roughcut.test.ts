import { describe, expect, it } from "vitest";
import { applyTransaction, compile, createProject, roughCut, sequence, type Op, type Project, type Transcript } from "../src/index";

const S = 1_000_000;
let n = 0;
function apply(p: Project, ops: Op[]): Project {
  return applyTransaction(p, { id: `t${++n}`, baseRevision: p.revision, by: "user", summary: "", ops }, { newId: (x) => `${x}${++n}` }).project;
}

/** Builds a transcript from text. "|1.5" inserts a pause of that many seconds. Words are 0.3 s long, 0.1 s apart. */
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

function project(_t: Transcript, lengthS = 60): Project {
  return apply(createProject(), [
    { op: "media.add", media: { id: "m1", path: "a.mp4", kind: "video", durationUs: Math.round(lengthS * S), probe: { hasVideo: true, hasAudio: true } } as never },
    { op: "clip.add", trackId: "main", mediaId: "m1", id: "c1" },
  ]);
}

const labels = (text: string, opts = {}) => {
  const t = speak(text);
  return roughCut(project(t, t.words[t.words.length - 1]!.endUs / S + 0.3), { m1: t }, opts).map((s) => `${s.kind}: ${s.label}`);
};

describe("rough cut suggestions", () => {
  it("keeps the last take when a line is restarted", () => {
    expect(labels("So today we are going to |0.6 so today we are going to build an editor")).toEqual(['retake: Repeated: "So today we are going to"']);
  });

  it("catches a stuttered short word but leaves emphasis and normal repetition alone", () => {
    expect(labels("open the the editor now")).toEqual(['retake: Repeated: "the"']);
    expect(labels("this is very very good")).toEqual([]);
    expect(labels("the model and the tools and the skills are ready")).toEqual([]);
    expect(labels("I think that I can do that")).toEqual([]);
    expect(labels("to be or not to be is the question")).toEqual([]);
    expect(labels("we will we will start now")).toEqual(['retake: Repeated: "we will"']);
    expect(labels("so today we are gonna look at so today we are going to build it")).toEqual(['retake: Repeated: "So today we are gonna look at"'.replace("So", "so")]);
  });

  it("removes filler words", () => {
    expect(labels("so um this is uh the editor")).toEqual(['filler: Filler: "um"', 'filler: Filler: "uh"']);
  });

  it("trims a long silence to about 0.8 s and leaves shorter pauses", () => {
    const t = speak("first part |1.4 second part |2.4 third part");
    let p = project(t, 6);
    const s = roughCut(p, { m1: t }, { retakes: false });
    // Only the 2.4 s pause; the 1.4 s one and the short tail stay.
    expect(s.map((x) => x.label)).toEqual(["Silence of 2.4 s"]);
    expect(s[0]!.savedUs).toBe(1.6 * S);
    const before = compile(p).durationUs;
    p = apply(p, s.flatMap((x) => x.ops));
    expect(before - compile(p).durationUs).toBe(1.6 * S);
    const pause = sequence(p, { m1: t }).filter((i) => i.kind === "pause" && i.removed);
    expect(pause).toHaveLength(1);
  });

  it("cuts dead air at the start and end fully, keeping a breath next to speech", () => {
    const t = speak("hello there");
    const p = project(t, 10); // speech ends at 1.2 s, then 8.8 s of nothing; 0.5 s before
    const s = roughCut(p, { m1: t });
    expect(s.map((x) => x.label)).toEqual(["Silence of 8.8 s at the end"]);
    expect(s[0]!.ops[0]).toMatchObject({ startUs: 1.2 * S + 0.8 * S, endUs: 10 * S });
  });

  it("suggests nothing twice once its suggestions are applied", () => {
    const t = speak("so um we will |3 we will start the the build now");
    let p = project(t, 8);
    const first = roughCut(p, { m1: t });
    expect(first.length).toBeGreaterThan(1);
    p = apply(p, first.flatMap((x) => x.ops));
    expect(roughCut(p, { m1: t })).toEqual([]);
  });

  it("leaves finished sentences alone when the next one only starts alike", () => {
    expect(labels("So let me explain what this is. This is connecting over the network")).toEqual([]);
    expect(labels("For this one, you're going to use your machines. It's usually an address. |0.9 You're going to use your computer login, not the other one")).toEqual([]);
    // A whole sentence said twice from its start is still a retake.
    expect(labels("Okay. Click the plus sign. |0.8 Click the plus sign. Then add it")).toEqual(['retake: Repeated: "Click the plus sign."']);
  });

  it("leaves the natural pause around a removed line, and takes flubs found by reading", () => {
    const t = speak("It may look confusing at first but we will break it down. |0.9 This may seem daunting, but it is simple. |0.7 Next step");
    const p = project(t, 12);
    const seq = sequence(p, { m1: t });
    const from = seq.findIndex((x) => x.text === "It");
    const to = seq.findIndex((x) => x.text === "down.");
    expect(roughCut(p, { m1: t }).filter((x) => x.kind === "retake")).toEqual([]);
    const s = roughCut(p, { m1: t }, { judged: [{ from, to, reason: "said again more simply" }, { from: 9999, to: 3 }] }).filter((x) => x.kind === "retake");
    expect(s.map((x) => x.label)).toEqual(['Flubbed line: "It may look confusing … break it down." (said again more simply)']);
    // Nothing before it, so it goes from the clip start; the next line keeps 0.4 s of its long pause.
    const next = seq.find((x) => x.text === "This")!;
    expect(s[0]!.ops[0]).toMatchObject({ startUs: 0, endUs: next.startUs - 0.4 * S, pad: false });
  });

  it("cuts only one copy of a repeat when the reader marked one and the word matcher sees the other", () => {
    const text = "We read a file, a debugger session, a debugger session, or a page and then we move on to the next part";
    const sug = labels(text, { judged: [{ from: 6, to: 8, reason: "repeated phrase" }] }).filter((l) => l.startsWith("retake"));
    expect(sug).toHaveLength(1);
  });
});
