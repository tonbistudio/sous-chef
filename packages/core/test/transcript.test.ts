import { describe, expect, it } from "vitest";
import { applyTransaction, compile, createProject, removeItemsOps, restoreItemsOps, searchSequence, sequence, type Op, type Project, type Transcript } from "../src/index";

const S = 1_000_000;
let n = 0;
function apply(p: Project, ops: Op[]): Project {
  return applyTransaction(p, { id: `t${++n}`, baseRevision: p.revision, by: "user", summary: "", ops }, { newId: (x) => `${x}${++n}` }).project;
}

// "so um this is the the editor [1.2 s pause] okay": one word per half second, 0.3 s long.
const texts = ["So", "um", "this", "is", "the", "the", "editor.", "Okay"];
const words = texts.map((text, i) => {
  const start = i < 7 ? 1 * S + i * 0.5 * S : 5.5 * S;
  return { id: `w${i}`, text, startUs: start, endUs: start + 0.3 * S };
});
const transcript: Transcript = { schema: 1, engine: "test", model: "test", words, silences: [] };
const T = { m1: transcript };

function base(): Project {
  return apply(createProject(), [
    { op: "media.add", media: { id: "m1", path: "a.mp4", kind: "video", durationUs: 10 * S, probe: { hasVideo: true, hasAudio: true } } as never },
    { op: "clip.add", trackId: "main", mediaId: "m1", id: "c1" },
  ]);
}

describe("transcript editing", () => {
  it("lists words in order with long gaps as pauses", () => {
    const seq = sequence(base(), T);
    expect(seq.map((i) => (i.kind === "pause" ? `[${i.text}]` : i.text)).join(" ")).toBe("[1.0s] So um this is the the editor. [1.2s] Okay [4.2s]");
    expect(seq.every((i) => !i.removed)).toBe(true);
  });

  it("deleting a word cuts from the word before to the word after, padded", () => {
    let p = base();
    let seq = sequence(p, T);
    const um = seq.findIndex((i) => i.text === "um");
    const ops = removeItemsOps(p, seq, um, um);
    expect(ops).toEqual([{ op: "range.remove", clipId: "c1", startUs: 1.4 * S, endUs: 1.9 * S, why: "user", pad: false, wordIds: ["w1"] }]);
    p = apply(p, ops);
    seq = sequence(p, T);
    expect(seq.filter((i) => i.removed).map((i) => i.text)).toEqual(["um"]);
    // The 0.2 s gaps on each side each give up 0.1 s of breathing room; the rest goes.
    expect(compile(p).durationUs).toBe(10 * S - 0.5 * S);
    // Deleting it again changes nothing.
    expect(removeItemsOps(p, seq, um, um)).toEqual([]);
  });

  it("deleting a pause leaves breathing room at both ends", () => {
    const p = base();
    const seq = sequence(p, T);
    const pause = seq.findIndex((i) => i.kind === "pause" && i.text === "1.2s");
    expect(removeItemsOps(p, seq, pause, pause, "silence")).toEqual([{ op: "range.remove", clipId: "c1", startUs: 4.4 * S, endUs: 5.4 * S, why: "silence", pad: false }]);
  });

  it("restoring one word out of a longer cut keeps the rest cut", () => {
    let p = base();
    let seq = sequence(p, T);
    const a = seq.findIndex((i) => i.text === "um");
    p = apply(p, removeItemsOps(p, seq, a, a + 2)); // um this is
    seq = sequence(p, T);
    expect(seq.filter((i) => i.removed).map((i) => i.text)).toEqual(["um", "this", "is"]);
    const thisWord = seq.findIndex((i) => i.text === "this");
    p = apply(p, restoreItemsOps(p, seq, thisWord, thisWord));
    seq = sequence(p, T);
    expect(seq.filter((i) => i.removed).map((i) => i.text)).toEqual(["um", "is"]);
    // Restoring everything leaves no cuts at all.
    p = apply(p, restoreItemsOps(p, seq, 0, seq.length - 1));
    expect((p.items.c1 as any).removed).toEqual([]);
  });

  it("shows a fixed word and finds phrases as you type", () => {
    const p = apply(base(), [{ op: "word.fix", mediaId: "m1", wordId: "w6", text: "Editor!" }]);
    const seq = sequence(p, T);
    expect(seq.find((i) => i.wordId === "w6")).toMatchObject({ text: "Editor!", fixed: true });
    expect(searchSequence(seq, "the the edi").map(([a, b]) => [seq[a]!.wordId, seq[b]!.wordId])).toEqual([["w4", "w6"]]);
    expect(searchSequence(seq, "THE")).toHaveLength(2);
    expect(apply(p, [{ op: "word.fix", mediaId: "m1", wordId: "w6", text: null }]).wordFixes).toEqual({});
  });

  it("only shows the words inside a trimmed or split clip", () => {
    const p = apply(base(), [{ op: "clip.split", clipId: "c1", atSourceUs: 2.9 * S, newId: "c2" }, { op: "clip.remove", clipId: "c1" }]);
    const seq = sequence(p, T);
    expect(seq.filter((i) => i.kind === "word").map((i) => i.text)).toEqual(["the", "the", "editor.", "Okay"]);
    expect(seq.every((i) => i.clipId === "c2")).toBe(true);
  });

  it("never keeps part of a deleted word when words run together", () => {
    // "one two three" with no gaps between the words at all.
    const run = [0, 1, 2].map((i) => ({ id: `r${i}`, text: ["one", "two", "three"][i]!, startUs: 1_000_000 + i * 400_000, endUs: 1_400_000 + i * 400_000 }));
    const TT = { m1: { ...transcript, words: run } };
    const p = base();
    const seq = sequence(p, TT);
    const two = seq.findIndex((i) => i.text === "two");
    expect(removeItemsOps(p, seq, two, two)).toMatchObject([{ startUs: 1_400_000, endUs: 1_800_000, pad: false }]);
  });
});
