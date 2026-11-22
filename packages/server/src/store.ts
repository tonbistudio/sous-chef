import { readPreferences } from "./library.js";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, copyFile, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  EditError,
  SCHEMA_VERSION,
  Session,
  applyPatch,
  compile,
  createProject,
  fillSettings,
  upgradeProject,
  type HistoryRecord,
  type Media,
  type Op,
  type Plan,
  type Project,
  type Transaction,
} from "@sous-chef/core";
import { probeMedia } from "./media.js";

export const PROJECT_EXT = ".sous";
/** Projects made before the rename end in .cutroom and still open. */
export const PROJECT_EXTS = /\.(sous|aigedit|cutroom)$/i;

export interface ChangeEvent {
  type: "change";
  projectId: string;
  revision: number;
  kind: "apply" | "undo" | "redo";
  by: "user" | "agent";
  summary: string;
  txId: string;
}

function newId(prefix: string): string {
  return prefix + randomBytes(4).toString("hex");
}

export function projectIdFor(dir: string): string {
  return createHash("sha1").update(path.resolve(dir).toLowerCase()).digest("hex").slice(0, 12);
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

/** One open project: state in memory, every change written to disk. */
export class OpenProject {
  readonly id: string;
  private session!: Session;
  private queue: Promise<unknown> = Promise.resolve();
  private planCache: Plan | null = null;
  private lastSnapshot = 0;

  private constructor(
    readonly dir: string,
    private onChange: (event: ChangeEvent) => void,
  ) {
    this.id = projectIdFor(dir);
  }

  static async open(dir: string, create: boolean, onChange: (event: ChangeEvent) => void): Promise<OpenProject> {
    const abs = path.resolve(dir);
    if (!PROJECT_EXTS.test(abs)) {
      throw new EditError("invalid", `A project folder must end in ${PROJECT_EXT}`);
    }
    const p = new OpenProject(abs, onChange);
    const file = p.file("project.json");
    let project: Project;
    let exists = true;
    try {
      await stat(file);
    } catch {
      exists = false;
    }
    if (!exists) {
      if (!create) throw new EditError("not_found", `No project at ${abs}`);
      await mkdir(abs, { recursive: true });
      const prefs = await readPreferences();
      project = createProject({ mainSpeed: prefs.newProjectSpeed, levelLufs: prefs.newProjectLufs });
      await writeAtomic(file, JSON.stringify(project, null, 2));
    } else {
      project = JSON.parse(await readFile(file, "utf8")) as Project;
      if (project.schemaVersion !== SCHEMA_VERSION) {
        throw new EditError("invalid", `Project schema ${project.schemaVersion} is not supported by this version`);
      }
    }
    const records = await p.readHistory();
    // Every record bumps the revision by one, so a project behind its history
    // means we crashed between the two writes. Replay what is missing.
    if (project.revision < records.length) {
      const byTx = new Map<string, Extract<HistoryRecord, { type: "apply" }>>();
      records.forEach((r, i) => {
        if (r.type === "apply") byTx.set(r.tx.id, r);
        if (i < project.revision) return;
        const source = r.type === "apply" ? r : byTx.get(r.txId);
        if (!source) throw new EditError("invalid", `History refers to unknown transaction "${(r as { txId: string }).txId}"`);
        project = applyPatch(project, r.type === "undo" ? source.inverse : source.forward);
      });
      await writeAtomic(file, JSON.stringify(project, null, 2));
    }
    fillSettings(project);
    upgradeProject(project);
    p.session = new Session(project, { newId });
    p.session.restore(records);
    return p;
  }

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  private async readHistory(): Promise<HistoryRecord[]> {
    let text: string;
    try {
      text = await readFile(this.file("history.jsonl"), "utf8");
    } catch {
      return [];
    }
    const records: HistoryRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as HistoryRecord);
      } catch {
        // A torn last line from a crash is ignored.
      }
    }
    return records;
  }

  get project(): Project {
    return this.session.project;
  }

  get plan(): Plan {
    if (!this.planCache || this.planCache.revision !== this.project.revision) {
      this.planCache = compile(this.project);
    }
    return this.planCache;
  }

  status() {
    return { ...this.session.peek(), canUndo: this.session.canUndo, canRedo: this.session.canRedo };
  }

  /** Absolute path of a media file. */
  mediaPath(media: Media): string {
    return path.isAbsolute(media.path) ? media.path : path.join(this.dir, media.path);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Copies the project file into autosave/, keeping the newest 20. Called
   * before risky steps, and at most every five minutes while editing.
   */
  async snapshot(reason: string): Promise<string | null> {
    const dir = this.file("autosave");
    try {
      await mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const name = `${stamp}-r${this.project.revision}-${reason.replace(/[^a-z0-9-]/gi, "")}.json`;
      await copyFile(this.file("project.json"), path.join(dir, name));
      this.lastSnapshot = Date.now();
      const all = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
      for (const old of all.slice(0, Math.max(0, all.length - 20))) await rm(path.join(dir, old), { force: true });
      return name;
    } catch {
      return null;
    }
  }

  private async persist(record: HistoryRecord): Promise<void> {
    // A copy of the state before this change, if the last copy is old.
    if (Date.now() - this.lastSnapshot > 5 * 60_000) await this.snapshot("auto");
    // History first: if we crash between the two writes, history is ahead and can be replayed.
    await appendFile(this.file("history.jsonl"), JSON.stringify(record) + "\n", "utf8");
    // From here the step is durable in history; a failed project.json write is retried on the next save
    // and recovered by replay on open, so it must not roll the step back in memory.
    try {
      await writeAtomic(this.file("project.json"), JSON.stringify(this.project, null, 2));
    } catch (err) {
      console.error(`Could not write project.json (history has the change; it is replayed on open): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Fills in what only the server can know: probes files named by media.add. */
  private async prepare(ops: Op[]): Promise<Op[]> {
    const out: Op[] = [];
    for (const op of ops) {
      if (op?.op === "media.add" && op.media && typeof op.media.path === "string" && op.media.durationUs === undefined) {
        const abs = path.isAbsolute(op.media.path) ? op.media.path : path.join(this.dir, op.media.path);
        const probed = await probeMedia(abs);
        const rel = path.relative(this.dir, abs);
        const inside = rel && !rel.startsWith("..") && !path.isAbsolute(rel);
        out.push({
          op: "media.add",
          media: { ...probed, path: inside ? rel.replace(/\\/g, "/") : probed.path, ...(op.media.id ? { id: op.media.id } : {}) },
        });
      } else if (op?.op === "media.relink" && op.media && typeof op.media.path === "string" && op.media.durationUs === undefined) {
        const abs = path.isAbsolute(op.media.path) ? op.media.path : path.join(this.dir, op.media.path);
        const probed = await probeMedia(abs);
        const rel = path.relative(this.dir, abs);
        const inside = rel && !rel.startsWith("..") && !path.isAbsolute(rel);
        out.push({ op: "media.relink", mediaId: op.mediaId, media: { ...probed, path: inside ? rel.replace(/\\/g, "/") : probed.path } });
      } else {
        out.push(op);
      }
    }
    return out;
  }

  apply(input: Partial<Transaction> & { ops: Op[] }) {
    return this.serial(async () => {
      if (!input || !Array.isArray(input.ops)) throw new EditError("invalid", "Transaction needs ops");
      const tx: Transaction = {
        id: input.id ?? newId("tx"),
        baseRevision: input.baseRevision as number,
        by: input.by ?? "user",
        summary: input.summary ?? "",
        ops: await this.prepare(input.ops),
        ...(input.instruction ? { instruction: input.instruction } : {}),
      };
      if (typeof tx.baseRevision !== "number") {
        throw new EditError("invalid", "baseRevision is required: send the revision you last read");
      }
      const cp = this.session.checkpoint();
      const outcome = this.session.apply(tx);
      if (outcome.record) {
        try {
          await this.persist(outcome.record);
        } catch (err) {
          // Not saved, so not applied: a retry of the same transaction must run again, not count as a duplicate.
          this.session.rollback(cp);
          throw err;
        }
        this.onChange({
          type: "change", projectId: this.id, revision: this.project.revision,
          kind: "apply", by: tx.by, summary: tx.summary, txId: tx.id,
        });
      }
      return { txId: tx.id, revision: this.project.revision, created: outcome.created, duplicate: outcome.duplicate };
    });
  }

  undo() {
    return this.step("undo");
  }

  redo() {
    return this.step("redo");
  }

  private step(kind: "undo" | "redo") {
    return this.serial(async () => {
      const cp = this.session.checkpoint();
      const result = kind === "undo" ? this.session.undo() : this.session.redo();
      try {
        await this.persist(result.record);
      } catch (err) {
        this.session.rollback(cp);
        throw err;
      }
      this.onChange({
        type: "change", projectId: this.id, revision: this.project.revision,
        kind, by: result.tx.by, summary: result.tx.summary, txId: result.tx.id,
      });
      return { revision: this.project.revision, txId: result.tx.id, summary: result.tx.summary };
    });
  }
}

/** All projects this server has open. */
export class Store {
  private projects = new Map<string, OpenProject>();
  private opening = new Map<string, Promise<OpenProject>>();

  constructor(private onChange: (event: ChangeEvent) => void) {}

  async open(dir: string, create = false): Promise<OpenProject> {
    const id = projectIdFor(dir);
    const existing = this.projects.get(id);
    if (existing) return existing;
    let pending = this.opening.get(id);
    if (!pending) {
      pending = OpenProject.open(dir, create, this.onChange).then((p) => {
        this.projects.set(id, p);
        return p;
      });
      this.opening.set(id, pending);
      pending.finally(() => this.opening.delete(id)).catch(() => undefined);
    }
    return pending;
  }

  get(id: string): OpenProject {
    const p = this.projects.get(id);
    if (!p) throw new EditError("not_found", `No open project "${id}". Open it first.`);
    return p;
  }

  list() {
    return [...this.projects.values()].map((p) => ({ projectId: p.id, path: p.dir, revision: p.project.revision }));
  }
}
