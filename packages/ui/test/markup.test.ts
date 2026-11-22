import { describe, expect, it } from "vitest";
import { describeMarks } from "../src/marks";

describe("describeMarks", () => {
  it("gives Hermes numbered marks in frame fractions, matching the picture", () => {
    const text = describeMarks(
      [
        { kind: "box", color: "#f9a302", a: [0.9, 0.3], b: [0.6, 0.1] },
        { kind: "point", color: "#f9a302", at: [0.25, 0.6] },
        { kind: "draw", color: "#ff4d4d", pts: [[0.4, 0.7], [0.6, 0.8], [0.5, 0.65]] },
      ],
      40_000_000,
    );
    expect(text).toBe(
      "frame at 40.00s on the timeline: box 1 from (0.60, 0.10) to (0.90, 0.30); point 2 at (0.25, 0.60); " +
        "stroke 3 (circled, underlined or pointed) covering x 0.40–0.60, y 0.65–0.80",
    );
  });
});
