import { describe, expect, it } from "vitest";
import { refineWords, unheardFillers } from "../src/refine";

const ms = 1000;
/** Levels every 10 ms: room noise at 10, speech at 1000, with optional loud stretches [fromMs, toMs, level]. */
function levels(totalMs: number, loud: [number, number, number][]): Float32Array {
  const out = new Float32Array(totalMs / 10).fill(10);
  for (const [a, b, v] of loud) for (let f = a / 10; f < b / 10; f++) out[f] = v;
  return out;
}

describe("word timing from the audio", () => {
  it("keeps a word going through a short dip and leaves a little room after it ends", () => {
    // Speech 1000-1500 ms with a 20 ms dip at 1300 (a stop consonant), the transcript says it ends at 1250.
    const lv = levels(4000, [[1000, 1300, 1000], [1320, 1500, 900], [3000, 3400, 1000]]);
    const [w] = refineWords([{ id: "a", text: "stop", startUs: 1000 * ms, endUs: 1250 * ms }, { id: "b", text: "next", startUs: 3000 * ms, endUs: 3400 * ms }], lv);
    expect(w!.endUs).toBeGreaterThanOrEqual(1500 * ms);
    expect(w!.endUs).toBeLessThanOrEqual(1560 * ms);
  });

  it("finds an unwritten um in a pause, but not a click or the room", () => {
    const lv = levels(6000, [[0, 1000, 1000], [1500, 1800, 700], [2200, 2220, 1000], [4000, 5000, 1000]]);
    const words = [
      { id: "a", text: "so", startUs: 0, endUs: 1000 * ms },
      { id: "b", text: "then", startUs: 4000 * ms, endUs: 5000 * ms },
    ];
    const found = unheardFillers(words, lv);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ text: "uh?", startUs: 1500 * ms, guessed: true });
  });
});
