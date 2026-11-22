import { describe, expect, it } from "vitest";
import { plainMessage } from "../src/messages";

describe("plainMessage", () => {
  it("turns a missing-file ffmpeg error into a short instruction", () => {
    const raw = "Prepare media failed: [in#0 @ 000001dbfe0f6a40] Error opening input: No such file or directory | Error opening input file C:/Users/me/Downloads/rea69-1.mp4. | Error opening input files: No such file or directory";
    expect(plainMessage(raw)).toBe("Prepare media: can't find rea69-1.mp4. It was moved or deleted; use Find… in Media to point to it.");
  });
  it("leaves ordinary messages alone", () => {
    expect(plainMessage("Rough cut is ready to review")).toBe("Rough cut is ready to review");
  });
});
