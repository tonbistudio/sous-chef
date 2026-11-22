import { describe, expect, it } from "vitest";
import { spokenText } from "../src/talk.js";

describe("spokenText", () => {
  it("drops markdown, code, links and file paths so the voice reads only words", () => {
    const reply = "## Done\n- Cut **14** flubs (`timeline.cut`)\n- Saved [52 s](https://x.y/z)\n```json\n{\"a\":1}\n```\nExport is at D:\\sous-chef\\out.mp4 now.";
    expect(spokenText(reply)).toBe("Done Cut 14 flubs (timeline.cut) Saved 52 s Export is at now.");
  });

  it("stops long replies at a sentence end", () => {
    const long = "First sentence here. " + "Word ".repeat(400);
    const said = spokenText(long, 120);
    expect(said.length).toBeLessThanOrEqual(120);
    expect(spokenText("One two three four. Five six. " + "x ".repeat(200), 40)).toBe("One two three four. Five six.");
  });
});
