import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let tmp = "";
const saved = { hermes: process.env.SOUS_CHEF_HERMES, home: process.env.SOUS_CHEF_HOME };

// A stand-in Hermes that streams its reply the way `hermes chat --format stream-json` does:
// small text pieces, a tool call in the middle, then a result with no final text.
const FAKE = `
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => {
  out({ type: "system", subtype: "init", session_id: "s1" });
  for (const t of ["I", "'m loc", "ating the open", " project in the editor so", " I can read", " the brief."]) out({ type: "text", text: t });
  out({ type: "tool_use", name: "image_generate" });
  out({ type: "tool_result", name: "image_generate" });
  for (const t of ["Done", ": three options", " are ready."]) out({ type: "text", text: t });
  out({ type: "result", session_id: "s1", exit_code: 0, text: "" });
});
`;

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sous-chat-"));
  process.env.SOUS_CHEF_HOME = path.join(tmp, "home");
  mkdirSync(process.env.SOUS_CHEF_HOME, { recursive: true });
  writeFileSync(path.join(tmp, "fake.mjs"), FAKE);
  if (process.platform === "win32") {
    writeFileSync(path.join(tmp, "hermes.cmd"), `@node "${path.join(tmp, "fake.mjs")}" %*\r\n`);
    process.env.SOUS_CHEF_HERMES = `"${path.join(tmp, "hermes.cmd")}"`;
  } else {
    writeFileSync(path.join(tmp, "hermes"), `#!/bin/sh\nexec node "${path.join(tmp, "fake.mjs")}" "$@"\n`, { mode: 0o755 });
    process.env.SOUS_CHEF_HERMES = path.join(tmp, "hermes");
  }
});

afterAll(() => {
  for (const [k, v] of [["SOUS_CHEF_HERMES", saved.hermes], ["SOUS_CHEF_HOME", saved.home]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("chat stream", () => {
  it("joins streamed pieces into one message, with a new paragraph only after a tool call", async () => {
    const { Chats } = await import("../src/chat.js");
    const project = path.join(tmp, "p.sous");
    mkdirSync(project);
    const chats = new Chats();
    await chats.send("p1", project, "Make a thumbnail", "");
    const ends = Date.now() + 20_000;
    let reply = "";
    while (Date.now() < ends) {
      const state = (await chats.state("p1", project)) as unknown as { messages: { role: string; text: string }[]; running: boolean };
      const last = state.messages[state.messages.length - 1];
      if (!state.running && last && last.role !== "user") {
        reply = last.text;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(reply).toBe("I'm locating the open project in the editor so I can read the brief.\n\nDone: three options are ready.");
  }, 30_000);
});
