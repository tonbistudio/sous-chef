import { randomBytes } from "node:crypto";

/** A background task the UI can show: transcription, proxy building and the like. */
export interface Job {
  id: string;
  kind: string;
  projectId: string;
  label: string;
  state: "running" | "done" | "failed" | "cancelled";
  /** 0..1 */
  progress: number;
  message: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  result?: unknown;
}

export interface JobHandle {
  job: Job;
  update(progress: number, message?: string): void;
  /** Set by the task so cancel() can stop it. */
  onCancel?: () => void;
  cancelled: boolean;
}

export class Jobs {
  private jobs = new Map<string, JobHandle>();

  constructor(private onChange: (job: Job) => void = () => {}) {}

  /** Runs a task as a job and returns at once. */
  start(kind: string, projectId: string, label: string, task: (handle: JobHandle) => Promise<unknown>): Job {
    const job: Job = { id: randomBytes(6).toString("hex"), kind, projectId, label, state: "running", progress: 0, message: "", startedAt: Date.now() };
    let last = 0;
    const handle: JobHandle = {
      job,
      cancelled: false,
      update: (progress, message) => {
        job.progress = Math.max(0, Math.min(0.999, progress));
        if (message !== undefined) job.message = message;
        if (Date.now() - last > 300) {
          last = Date.now();
          this.onChange(job);
        }
      },
    };
    this.jobs.set(job.id, handle);
    this.onChange(job);
    task(handle)
      .then((result) => {
        job.state = handle.cancelled ? "cancelled" : "done";
        job.result = result;
        if (job.state === "done") job.progress = 1;
      })
      .catch((err: unknown) => {
        job.state = handle.cancelled ? "cancelled" : "failed";
        if (job.state === "failed") job.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        job.finishedAt = Date.now();
        this.onChange(job);
      });
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id)?.job;
  }

  list(projectId: string): Job[] {
    return [...this.jobs.values()].map((h) => h.job).filter((j) => j.projectId === projectId);
  }

  running(projectId: string, kind: string): Job | undefined {
    return this.list(projectId).find((j) => j.kind === kind && j.state === "running");
  }

  anyRunning(): boolean {
    return [...this.jobs.values()].some((h) => h.job.state === "running");
  }

  cancel(id: string): boolean {
    const h = this.jobs.get(id);
    if (!h || h.job.state !== "running") return false;
    h.cancelled = true;
    h.onCancel?.();
    return true;
  }

  stopAll(): void {
    for (const h of this.jobs.values()) if (h.job.state === "running") this.cancel(h.job.id);
  }
}
