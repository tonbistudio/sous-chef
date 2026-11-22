import { applyTransaction, type ApplyOptions } from "./apply.js";
import { applyPatch } from "./project.js";
import { EditError, type Patch, type Project, type Transaction } from "./types.js";

/** One line of history.jsonl. */
export type HistoryRecord =
  | { type: "apply"; tx: Transaction; forward: Patch; inverse: Patch; created: (string | null)[]; at: string }
  | { type: "undo"; txId: string; at: string }
  | { type: "redo"; txId: string; at: string };

interface Entry {
  tx: Transaction;
  forward: Patch;
  inverse: Patch;
  created: (string | null)[];
}

export interface ApplyOutcome {
  project: Project;
  record: HistoryRecord | null;
  created: (string | null)[];
  /** True when the transaction id had already been applied and nothing changed. */
  duplicate: boolean;
}

/**
 * A project plus its undo and redo stacks. Pure: it returns records for the
 * caller to persist and never touches the disk.
 */
export class Session {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private applied = new Map<string, Entry>();

  constructor(
    public project: Project,
    private opts: ApplyOptions,
    private now: () => string = () => new Date().toISOString(),
  ) {}

  /** Rebuilds the stacks from saved history. Does not change the project. */
  restore(records: HistoryRecord[]): void {
    this.undoStack = [];
    this.redoStack = [];
    this.applied.clear();
    for (const r of records) {
      if (r.type === "apply") {
        const entry: Entry = { tx: r.tx, forward: r.forward, inverse: r.inverse, created: r.created };
        this.applied.set(r.tx.id, entry);
        this.undoStack.push(entry);
        this.redoStack = [];
      } else if (r.type === "undo") {
        const entry = this.undoStack.pop();
        if (entry) this.redoStack.push(entry);
      } else if (r.type === "redo") {
        const entry = this.redoStack.pop();
        if (entry) this.undoStack.push(entry);
      }
    }
  }

  apply(tx: Transaction): ApplyOutcome {
    const seen = this.applied.get(tx?.id);
    if (seen) return { project: this.project, record: null, created: seen.created, duplicate: true };
    const result = applyTransaction(this.project, tx, this.opts);
    const entry: Entry = { tx, forward: result.forward, inverse: result.inverse, created: result.created };
    this.project = result.project;
    this.applied.set(tx.id, entry);
    this.undoStack.push(entry);
    this.redoStack = [];
    return {
      project: this.project,
      record: { type: "apply", tx, forward: entry.forward, inverse: entry.inverse, created: entry.created, at: this.now() },
      created: result.created,
      duplicate: false,
    };
  }

  /** The whole in-memory state, to put back if saving a step fails. */
  checkpoint(): { project: Project; undo: Entry[]; redo: Entry[]; applied: Map<string, Entry> } {
    return { project: this.project, undo: [...this.undoStack], redo: [...this.redoStack], applied: new Map(this.applied) };
  }

  /** Goes back to a checkpoint: memory never runs ahead of what is on disk. */
  rollback(cp: ReturnType<Session["checkpoint"]>): void {
    this.project = cp.project;
    this.undoStack = cp.undo;
    this.redoStack = cp.redo;
    this.applied = cp.applied;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Summaries of what undo and redo would affect, newest first. */
  peek(): { undo: string | null; redo: string | null } {
    return {
      undo: this.undoStack.at(-1)?.tx.summary ?? null,
      redo: this.redoStack.at(-1)?.tx.summary ?? null,
    };
  }

  undo(): { project: Project; record: HistoryRecord; tx: Transaction } {
    const entry = this.undoStack.pop();
    if (!entry) throw new EditError("invalid", "Nothing to undo");
    this.project = applyPatch(this.project, entry.inverse);
    this.redoStack.push(entry);
    return { project: this.project, record: { type: "undo", txId: entry.tx.id, at: this.now() }, tx: entry.tx };
  }

  redo(): { project: Project; record: HistoryRecord; tx: Transaction } {
    const entry = this.redoStack.pop();
    if (!entry) throw new EditError("invalid", "Nothing to redo");
    this.project = applyPatch(this.project, entry.forward);
    this.undoStack.push(entry);
    return { project: this.project, record: { type: "redo", txId: entry.tx.id, at: this.now() }, tx: entry.tx };
  }
}
