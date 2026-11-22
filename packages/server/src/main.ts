#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { editorUrl, findServer, homeDir, lockFile, migrateHome } from "./connect.js";
import { startServer } from "./http.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** With --log, output goes to a file; a server started by a window has no console. */
function redirectOutput(file: string): void {
  const write = (...parts: unknown[]) => {
    try {
      appendFileSync(file, parts.map((p) => (p instanceof Error ? (p.stack ?? p.message) : String(p))).join(" ") + "\n");
    } catch {
      /* nowhere left to report to */
    }
  };
  console.log = write;
  console.error = write;
  console.warn = write;
}

async function main(): Promise<void> {
  const logFile = arg("log");
  if (logFile) redirectOutput(logFile);
  const running = await findServer();
  if (running) {
    console.log(`Sous Chef server is already running on port ${running.port} (pid ${running.pid}).`);
    return;
  }
  if (await migrateHome().catch((e) => { console.error("Could not bring settings over from AI Garage Editor:", e); return false; })) {
    console.log(`Brought settings and the library over from AI Garage Editor into ${homeDir()}`);
  }
  const token = randomBytes(24).toString("hex");
  const server = await startServer({ port: Number(arg("port") ?? 0), token });
  const info = { port: server.port, token, pid: process.pid };
  await mkdir(homeDir(), { recursive: true });
  await writeFile(lockFile(), JSON.stringify({ ...info, startedAt: new Date().toISOString() }, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  // How to start this server again; the Hermes page uses it when no server is running.
  await writeFile(
    path.join(homeDir(), "install.json"),
    JSON.stringify({ exec: process.execPath, entry: fileURLToPath(import.meta.url) }, null, 2),
    "utf8",
  );
  console.log(`[${new Date().toISOString()}] Sous Chef server listening on http://127.0.0.1:${server.port} (pid ${process.pid})`);
  console.log(`Connection details: ${lockFile()}`);

  const project = arg("project");
  let projectId: string | undefined;
  if (project) {
    const p = await server.store.open(project, process.argv.includes("--create"));
    console.log(`Opened project ${p.id} at ${p.dir} (revision ${p.project.revision})`);
    projectId = p.id;
  }
  console.log(`Open the editor: ${editorUrl(info, projectId)}`);

  let closing = false;
  const stop = async (why: string) => {
    if (closing) return;
    closing = true;
    console.log(`[${new Date().toISOString()}] Stopping: ${why}`);
    // Only remove the lock if it is still ours.
    try {
      const current = JSON.parse(await readFile(lockFile(), "utf8")) as { pid?: number };
      if (current.pid === process.pid) await rm(lockFile(), { force: true });
    } catch {
      /* already gone */
    }
    await server.close();
    process.exit(0);
  };
  server.onShutdown(() => void stop("asked to stop"));
  process.on("SIGINT", () => void stop("interrupted"));
  process.on("SIGTERM", () => void stop("terminated"));

  // A server started on demand by a window goes away once every window has been gone for a while.
  const idleMinutes = Number(arg("idle-exit-minutes") ?? 0);
  if (idleMinutes > 0) {
    setInterval(() => {
      if (server.idleMs() > idleMinutes * 60_000) void stop(`no window connected for ${idleMinutes} minutes`);
    }, 15_000).unref();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
