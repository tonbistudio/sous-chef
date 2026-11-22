import { applyTransaction, compile, createProject, type Op, type Project } from "@sous-chef/core";
import { describe, expect, it } from "vitest";
import { callTool, expandOps, type EditApi } from "../src/tools";

const S = 1_000_000;
let n = 0;

/** An in-memory stand-in for the edit server, built on the real engine. */
function fakeServer() {
  let project = createProject();
  const posts: { path: string; body: any }[] = [];
  const apply = (ops: Op[], by: "user" | "agent" = "user") => {
    project = applyTransaction(project, { id: `t${++n}`, baseRevision: project.revision, by, summary: "", ops }, { newId: (p) => `${p}${++n}` }).project;
  };
  apply([
    { op: "media.add", media: { id: "m1", path: "a.mp4", kind: "video", durationUs: 60 * S, probe: { hasVideo: true, hasAudio: true } } as never },
    { op: "clip.add", trackId: "main", mediaId: "m1", sourceInUs: 0, sourceOutUs: 20 * S, id: "a" },
    { op: "clip.add", trackId: "main", mediaId: "m1", sourceInUs: 40 * S, sourceOutUs: 60 * S, id: "b" },
  ]);
  const api: EditApi = {
    get: async (path) => {
      if (path.endsWith("/plan")) return compile(project) as never;
      if (path.endsWith("/project")) return { projectId: "p1", path: "x.sous", project, history: { undo: null, redo: null, canUndo: false, canRedo: false } } as never;
      return { projects: [{ projectId: "p1" }] } as never;
    },
    post: async (path, body: any) => {
      posts.push({ path, body });
      if (path.endsWith("/transactions")) apply(body.ops, body.by);
      return { revision: project.revision } as never;
    },
    frame: async () => ({ jpeg: Buffer.from([0xff, 0xd8, 0xff]), mediaId: "m1", sourceUs: 13 * S }),
  };
  return { api, posts, project: () => project };
}

const parse = (r: { content: any[] }) => JSON.parse(r.content.find((c) => c.type === "text").text);

describe("agent tools", () => {
  it("reads a project as clips in play order with timeline positions", async () => {
    const { api } = fakeServer();
    const p = parse(await callTool(api, "project", { action: "get", project_id: "p1" }));
    expect(p.durationUs).toBe(40 * S);
    expect(p.mainClips.map((c: any) => [c.id, c.timelineStartUs, c.timelineEndUs])).toEqual([["a", 0, 20 * S], ["b", 20 * S, 40 * S]]);
  });

  it("applies a timeline cut across two clips as one agent step", async () => {
    const { api, posts, project } = fakeServer();
    const rev = project().revision;
    const out = parse(await callTool(api, "edit_apply", { project_id: "p1", base_revision: rev, summary: "Cut 18 to 25", ops: [{ op: "timeline.cut", startUs: 18 * S, endUs: 25 * S }] }));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.by).toBe("agent");
    expect(posts[0]!.body.ops).toEqual([
      { op: "range.remove", clipId: "a", startUs: 18 * S, endUs: 20 * S },
      { op: "range.remove", clipId: "b", startUs: 40 * S, endUs: 45 * S },
    ]);
    expect(out.durationAfter).toBe("33.00s");
    expect(out.project.mainClips[0].cuts).toHaveLength(1);
  });

  it("refuses a stale revision before sending anything", async () => {
    const { api, posts, project } = fakeServer();
    await expect(callTool(api, "edit_apply", { project_id: "p1", base_revision: project().revision - 1, summary: "x", ops: [{ op: "timeline.split", atUs: 5 * S }] })).rejects.toThrow(/stale_revision/);
    expect(posts).toHaveLength(0);
  });

  it("explains a cut or split that lands on nothing", () => {
    const { project } = fakeServer();
    const plan = compile(project());
    expect(() => expandOps([{ op: "timeline.cut", startUs: 50 * S, endUs: 60 * S }], plan)).toThrow(/covers nothing/);
    expect(() => expandOps([{ op: "timeline.split", atUs: 20 * S }], plan)).toThrow(/clip edge/);
    expect(expandOps([{ op: "clip.remove", clipId: "a" }], plan)).toEqual([{ op: "clip.remove", clipId: "a" }]);
  });

  it("returns a frame as an image with where it came from", async () => {
    const { api } = fakeServer();
    const r = await callTool(api, "frame_get", { project_id: "p1", timeline_us: 11 * S });
    expect(r.content[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect(parse(r).sourceUs).toBe(13 * S);
    await expect(callTool(api, "frame_get", { project_id: "p1" })).rejects.toThrow(/timeline_us/);
  });
});
