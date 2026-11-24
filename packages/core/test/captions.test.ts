import { describe, expect, it } from "vitest";
import { applyTransaction, captionCues, compile, removeItemsOps, sequence, createProject, toAss, toSrt, type Op, type Project, type Transcript } from "../src/index";

const S = 1_000_000;
let n = 0;
const apply = (p: Project, ops: Op[]) => applyTransaction(p, { id: `t${++n}`, baseRevision: p.revision, by: "user", summary: "", ops }, { newId: (x) => `${x}${++n}` }).project;

// Ten words half a second apart from 1 s, then a 2 s gap, then three more.
const texts = "Welcome to the editor. It cuts by the words you say right now".split(" ");
const words = texts.map((text, i) => {
  const start = (i < 10 ? 1 + i * 0.5 : 8 + (i - 10) * 0.5) * S;
  return { id: `w${i}`, text, startUs: start, endUs: start + 0.4 * S };
});
const T = { m1: { schema: 1, engine: "t", model: "t", words, silences: [] } as Transcript };
const base = () =>
  apply(createProject(), [
    { op: "media.add", media: { id: "m1", path: "a.mp4", kind: "video", durationUs: 12 * S, probe: { hasVideo: true, hasAudio: true } } as never },
    { op: "clip.add", trackId: "main", mediaId: "m1", id: "c1" },
  ]);

describe("captions", () => {
  it("breaks at sentence ends, long pauses and the word limit", () => {
    const p = base();
    const cues = captionCues(p, T, compile(p));
    // A sentence end, then the 2 s gap, each start a new caption.
    expect(cues.map((c) => c.text)).toEqual(["Welcome to the editor.", "It cuts by the words you", "say right now"]);
    expect(cues[0]!.startUs).toBe(1 * S);
    // No cue overlaps the next.
    for (let i = 1; i < cues.length; i++) expect(cues[i]!.startUs).toBeGreaterThanOrEqual(cues[i - 1]!.endUs);
  });

  it("follows cuts and word fixes, and moves earlier when material before is removed", () => {
    let p = base();
    const before = captionCues(p, T, compile(p));
    p = apply(p, [
      { op: "range.remove", clipId: "c1", startUs: 0, endUs: 0.9 * S }, // dead air at the start
      { op: "range.remove", clipId: "c1", startUs: 2.4 * S, endUs: 3 * S, wordIds: ["w3"] }, // "editor."
      { op: "word.fix", mediaId: "m1", wordId: "w0", text: "Hello" },
    ]);
    const after = captionCues(p, T, compile(p));
    expect(after[0]!.text.startsWith("Hello to the")).toBe(true);
    expect(after.map((c) => c.text).join(" ")).not.toContain("editor");
    expect(after[0]!.startUs).toBe(before[0]!.startUs - 0.9 * S);
  });

  it("respects the words-per-caption and uppercase settings", () => {
    const p = apply(base(), [{ op: "settings.set", settings: { captions: { maxWords: 3, uppercase: true } } }]);
    const cues = captionCues(p, T, compile(p));
    expect(cues.every((c) => c.text.split(" ").length <= 3)).toBe(true);
    expect(cues[0]!.text).toBe("WELCOME TO THE");
  });

  it("writes SRT and ASS, and can cut ASS down to one part of the video", () => {
    const p = base();
    const cues = captionCues(p, T, compile(p));
    const srt = toSrt(cues);
    expect(srt.startsWith("1\n00:00:01,000 --> ")).toBe(true);
    const ass = toAss(cues, p.settings.captions, 1920, 1080);
    expect(ass).toContain("PlayResY: 1080");
    expect(ass).toContain("Dialogue: 0,0:00:01.00,");
    const part = toAss(cues, p.settings.captions, 1920, 1080, 8 * S, 12 * S);
    expect(part.match(/Dialogue:/g)!.length).toBeLessThan(ass.match(/Dialogue:/g)!.length);
    expect(part).toContain("Dialogue: 0,0:00:00.00,");
  });

  it("captions a voiceover where it sits and drops the words of a muted clip", () => {
    let p = base();
    const voice = { schema: 1, engine: "t", model: "t", silences: [], words: [{ id: "v0", text: "Spoken", startUs: 0.2 * S, endUs: 0.6 * S }, { id: "v1", text: "later.", startUs: 0.7 * S, endUs: 1.1 * S }] } as Transcript;
    p = apply(p, [
      { op: "media.add", media: { id: "m2", path: "vo.m4a", kind: "audio", durationUs: 2 * S, probe: { hasVideo: false, hasAudio: true } } as never },
      { op: "track.add", kind: "audio", id: "vo", name: "Voiceover" },
      { op: "clip.add", trackId: "vo", mediaId: "m2", startUs: 20 * S, id: "cv" },
    ]);
    const all = { ...T, m2: voice };
    const withVoice = captionCues(p, all, compile(p));
    expect(withVoice[withVoice.length - 1]).toMatchObject({ text: "Spoken later.", startUs: 20.2 * S });
    // The transcript lists the voiceover after the take it follows, and its words can be cut like any other.
    const seq = sequence(p, all);
    const first = seq.findIndex((i) => i.voice);
    expect(seq[first]).toMatchObject({ text: "Spoken", clipId: "cv", tlStartUs: 20.2 * S });
    expect(removeItemsOps(p, seq, first, first)).toEqual([expect.objectContaining({ op: "range.remove", clipId: "cv", wordIds: ["v0"] })]);
    expect(sequence(p, all, { voice: false }).some((i) => i.voice)).toBe(false);
    // Spoken over the take, the voiceover is what gets captioned there.
    p = apply(p, [{ op: "clip.move", clipId: "cv", startUs: 0.7 * S } as never]);
    const over = captionCues(p, all, compile(p)).map((c) => c.text);
    expect(over[0]).toBe("Spoken later.");
    expect(over.join(" ")).not.toContain("Welcome");
    expect(over.join(" ")).toContain("right now");
    // Muting the take leaves only the voiceover to caption.
    p = apply(p, [{ op: "clip.set", clipId: "c1", muted: true } as never]);
    expect(captionCues(p, all, compile(p)).map((c) => c.text)).toEqual(["Spoken later."]);
  });
});
