import { compile, sequence, type Clip, type Op, type Plan, type Project, type Proposal, type SeqItem, type Transcripts , captionCues, type Cue } from "@sous-chef/core";
import { plainMessage } from "./messages";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, subscribe, type ChatState, type HistoryStatus, type Job, type Prepared } from "./api";
import { Player } from "./player";

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
  /** How many times the same message came in while it was showing. */
  count: number;
}


export interface Editor {
  pid: string;
  path: string;
  project: Project;
  plan: Plan;
  history: HistoryStatus;
  connected: boolean;
  player: Player;
  selectedClipId: string | null;
  selectClip: (id: string | null) => void;
  selectedZoomId: string | null;
  selectedOverlayId: string | null;
  selectOverlay: (id: string | null) => void;
  /** Captions as they will appear, worked out from the kept words. */
  cues: Cue[];
  selectZoom: (id: string | null) => void;
  /** A marked stretch of the timeline, in timeline microseconds. */
  range: [number, number] | null;
  setRange: (r: [number, number] | null) => void;
  toasts: Toast[];
  notify: (text: string, kind?: Toast["kind"]) => void;
  dismiss: (id: number) => void;
  run: (summary: string, ops: Op[]) => Promise<(string | null)[] | null>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  clips: Clip[];
  /** Word lists per media id, for the media that have been transcribed. */
  transcripts: Transcripts;
  /** Whether this computer can transcribe at all. */
  canTranscribe: boolean;
  /** The edit's words and pauses in play order. */
  seq: SeqItem[];
  /** Background work: transcription and the like. */
  jobs: Job[];
  transcribe: (mediaIds?: string[], redo?: boolean) => Promise<void>;
  /** What has been built for each media file: proxy, sound outline, pictures. */
  prepared: Record<string, Prepared>;
  /** HyperFrames overlays whose current version is rendered (id → version). */
  renderedOverlays: Record<string, string>;
  /** The conversation with Hermes about this project. */
  chat: ChatState;
  /** Suggested edits waiting for a yes or no. */
  proposals: Proposal[];
  /** Suggestions the owner has unticked; they are not applied on accept. */
  skipped: Set<string>;
  setSkipped: (s: Set<string>) => void;
  roughCut: () => Promise<void>;
  /** Zoom suggestions only, without cuts. */
  autoZoom: () => Promise<void>;
  acceptProposal: (p: Proposal) => Promise<void>;
  rejectProposal: (p: Proposal) => Promise<void>;
}

let toastId = 0;

export function useEditor(pid: string): Editor | null {
  const [data, setData] = useState<{ path: string; project: Project; history: HistoryStatus } | null>(null);
  const [connected, setConnected] = useState(false);
  const [selectedClipId, selectClip] = useState<string | null>(null);
  const [range, setRange] = useState<[number, number] | null>(null);
  const [selectedZoomId, selectZoom] = useState<string | null>(null);
  const [selectedOverlayId, selectOverlay] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const player = useMemo(() => new Player(), []);
  const revision = useRef(-1);
  const [transcripts, setTranscripts] = useState<Transcripts>({});
  const [canTranscribe, setCanTranscribe] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);

  const [prepared, setPrepared] = useState<Record<string, Prepared>>({});
  const loadCache = useCallback(async () => {
    const r = await api.cache(pid);
    setPrepared(r.media);
    player.setProxies(Object.entries(r.media).filter(([, v]) => v.proxy).map(([id]) => id));
    const o = await api.overlayState(pid).catch(() => ({ rendered: {} }));
    setRenderedOverlays(o.rendered);
    player.setRenderedOverlays(o.rendered);
  }, [pid, player]);

  // An edited overlay goes back to "rendering" until its new file is ready.
  const overlayRev = data?.project.revision;
  useEffect(() => {
    if (overlayRev === undefined) return;
    void api.overlayState(pid).then((o) => {
      setRenderedOverlays(o.rendered);
      player.setRenderedOverlays(o.rendered);
    }).catch(() => undefined);
  }, [pid, player, overlayRev]);

  const [renderedOverlays, setRenderedOverlays] = useState<Record<string, string>>({});
  const [chat, setChat] = useState<ChatState>({ messages: [], running: false, activity: "" });
  useEffect(() => {
    void api.chat(pid).then(setChat).catch(() => undefined);
  }, [pid]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const loadProposals = useCallback(async () => {
    const r = await api.proposals(pid);
    setProposals(r.proposals);
    setSkipped(new Set());
  }, [pid]);

  const loadTranscripts = useCallback(async () => {
    const r = await api.transcripts(pid);
    setTranscripts(r.transcripts);
    setCanTranscribe(r.ready);
  }, [pid]);

  const notify = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const plain = plainMessage(text);
    const id = ++toastId;
    // The same message again (a retry, several files at once) adds to the one showing instead of stacking.
    setToasts((t) => {
      const same = t.find((x) => x.text === plain && x.kind === kind);
      if (same) return t.map((x) => (x === same ? { ...x, id, count: x.count + 1 } : x));
      return [...t.slice(-2), { id, text: plain, kind, count: 1 }];
    });
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 8000 : 3000);
  }, []);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const refresh = useCallback(async () => {
    const res = await api.project(pid);
    // Responses can arrive out of order; never go back to an older revision.
    if (res.project.revision < revision.current) return;
    revision.current = res.project.revision;
    setData({ path: res.path, project: res.project, history: res.history });
  }, [pid]);

  useEffect(() => {
    revision.current = -1;
    setData(null);
    refresh().catch((e) => notify(e instanceof Error ? e.message : String(e), "error"));
    setTranscripts({});
    loadTranscripts().catch(() => undefined);
    setPrepared({});
    loadCache().catch(() => undefined);
    setProposals([]);
    loadProposals().catch(() => undefined);
    api.jobs(pid).then((r) => setJobs(r.jobs.filter((j) => j.state === "running"))).catch(() => undefined);
    return subscribe(
      (e) => {
        if (e.type === "cache") {
          if (e.projectId === pid) loadCache().catch(() => undefined);
          return;
        }
        if (e.type === "chat") {
          if (e.projectId === pid) setChat(e.chat);
          return;
        }
        if (e.type === "proposals") {
          if (e.projectId === pid) loadProposals().catch(() => undefined);
          return;
        }
        if (e.type === "export") return;
        if (e.type === "job") {
          if (e.job.projectId !== pid) return;
          setJobs((list) => [...list.filter((j) => j.id !== e.job.id), ...(e.job.state === "running" ? [e.job] : [])]);
          if (e.job.state === "done") {
            if (e.job.kind === "transcribe") loadTranscripts().catch(() => undefined);
            if (e.job.kind === "prepare") loadCache().catch(() => undefined);
            else if (e.job.kind === "roughcut") {
              const r = (e.job as { result?: { proposal?: string | null; summary?: string } }).result;
              notify(r?.proposal ? `${e.job.label} is ready to review` : `${e.job.label}: ${e.job.label === "Auto zoom" ? "no good places to zoom found" : "nothing to suggest"}`);
            } else notify(`${e.job.label}: done`);
          } else if (e.job.state === "failed") notify(`${e.job.label} failed: ${e.job.error ?? ""}`, "error");
          return;
        }
        if (e.type !== "change") return;
        if (e.projectId !== pid) return;
        if (e.by === "agent") notify(`Hermes: ${e.kind === "apply" ? e.summary || "edit" : e.kind}`);
        refresh().catch(() => undefined);
      },
      (ok) => {
        setConnected(ok);
        if (ok) refresh().catch(() => undefined);
      },
    );
  }, [pid, refresh, notify, loadTranscripts, loadCache, loadProposals]);

  const seq = useMemo(() => (data ? sequence(data.project, transcripts, { voice: true }) : []), [data, transcripts]);

  const plan = useMemo(() => (data ? compile(data.project) : null), [data]);
  const cues = useMemo(() => (data && plan ? captionCues(data.project, transcripts, plan) : []), [data, plan, transcripts]);

  useEffect(() => {
    if (plan) player.setPlan(plan, pid);
  }, [plan, pid, player]);

  useEffect(() => {
    if (selectedClipId && data && !data.project.items[selectedClipId]) selectClip(null);
    if (selectedZoomId && data && !data.project.items[selectedZoomId]) selectZoom(null);
    if (selectedOverlayId && data && !data.project.items[selectedOverlayId]) selectOverlay(null);
  }, [data, selectedClipId, selectedZoomId, selectedOverlayId]);

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.code === "stale_revision") {
        notify("The project changed while you were editing. Try again.", "error");
        refresh().catch(() => undefined);
      } else {
        notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
    [notify, refresh],
  );

  // Local edits go one at a time, each based on the revision the previous one produced, so two quick
  // clicks never race on the same base revision (the second would be refused as stale and lost).
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const run = useCallback(
    (summary: string, ops: Op[]) => {
      const next = queue.current.then(async () => {
        try {
          const res = await api.apply(pid, revision.current, summary, ops);
          revision.current = Math.max(revision.current, res.revision);
          await refresh();
          return res.created;
        } catch (e) {
          fail(e);
          return null;
        }
      });
      queue.current = next.catch(() => undefined);
      return next;
    },
    [pid, refresh, fail],
  );

  const undo = useCallback(async () => {
    try {
      const r = await api.undo(pid);
      notify(`Undid: ${r.summary || "edit"}`);
      await refresh();
    } catch (e) {
      fail(e);
    }
  }, [pid, refresh, fail, notify]);

  const redo = useCallback(async () => {
    try {
      const r = await api.redo(pid);
      notify(`Redid: ${r.summary || "edit"}`);
      await refresh();
    } catch (e) {
      fail(e);
    }
  }, [pid, refresh, fail, notify]);

  const transcribe = useCallback(
    async (mediaIds?: string[], redo = false) => {
      try {
        const r = await api.transcribe(pid, mediaIds, redo);
        if (!r.job) notify(r.message ?? "Nothing to transcribe");
      } catch (e) {
        fail(e);
      }
    },
    [pid, fail, notify],
  );

  const roughCut = useCallback(async () => {
    try {
      await api.roughcut(pid);
    } catch (e) {
      fail(e);
    }
  }, [pid, fail]);
  const autoZoom = useCallback(async () => {
    try {
      await api.roughcut(pid, { zooms: true, cuts: false });
    } catch (e) {
      fail(e);
    }
  }, [pid, fail]);

  const acceptProposal = useCallback(
    async (p: Proposal) => {
      try {
        const ids = p.items.filter((i) => !skipped.has(i.id)).map((i) => i.id);
        const r = await api.proposalAccept(pid, p.id, ids);
        notify(`Applied ${r.accepted} suggestion${r.accepted === 1 ? "" : "s"}${r.skipped ? `, ${r.skipped} no longer fit` : ""}. Undo brings them all back.`);
        await refresh();
      } catch (e) {
        fail(e);
      }
    },
    [pid, skipped, notify, refresh, fail],
  );

  const rejectProposal = useCallback(
    async (p: Proposal) => {
      try {
        await api.proposalReject(pid, p.id);
      } catch (e) {
        fail(e);
      }
    },
    [pid, fail],
  );

  if (!data || !plan) return null;
  const main = data.project.tracks.find((t) => t.kind === "main");
  const clips = (main?.items ?? [])
    .map((id) => data.project.items[id])
    .filter((i): i is Clip => Boolean(i) && i!.type === "clip");

  return {
    pid, path: data.path, project: data.project, plan, history: data.history, connected, player,
    selectedClipId, selectClip, selectedZoomId, selectZoom, selectedOverlayId, selectOverlay, cues, range, setRange, toasts, notify, dismiss, run, undo, redo, clips,
    transcripts, canTranscribe, seq, jobs, transcribe, prepared,
    renderedOverlays, chat, proposals, skipped, setSkipped, roughCut, autoZoom, acceptProposal, rejectProposal,
  };
}
