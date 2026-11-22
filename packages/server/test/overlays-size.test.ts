import { describe, expect, it } from "vitest";
import { fillTemplate, overlayKey } from "../src/overlays.js";

describe("graphics on a timeline of another shape", () => {
  it("draws the template page at the frame size, both ways round", async () => {
    const tall = await fillTemplate("lower-third", { title: "T" }, 5_000_000, [1080, 1920]);
    expect(tall).toContain('content="width=1080, height=1920"');
    expect(tall).toContain("width: 1080px; height: 1920px");
    expect(tall).toContain('data-width="1080" data-height="1920"');
    const wide = await fillTemplate("lower-third", { title: "T" }, 5_000_000);
    expect(wide).toContain('data-width="1920" data-height="1080"');
  });

  it("keeps 16:9 cache keys as they were and gives other sizes their own", () => {
    const o = { template: "lower-third", params: { title: "T" }, durationUs: 5_000_000 };
    expect(overlayKey(o, [1920, 1080])).toBe(overlayKey(o));
    expect(overlayKey(o, [1080, 1920])).not.toBe(overlayKey(o));
  });
});
