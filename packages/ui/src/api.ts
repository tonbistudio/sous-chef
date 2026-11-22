import type { Op, Plan, Project, Proposal, Transcripts } from "@sous-chef/core";
import { session } from "./storage";

const params = new URLSearchParams(location.search);
const fromUrl = params.get("token");
if (fromUrl) session.set("sous.token", fromUrl);
export const token = fromUrl ?? session.get("sous.token") ?? "";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.code ?? "error", data?.error?.message ?? res.statusText, data?.error?.details);
  }
  return data as T;
}

export interface HistoryStatus {
  undo: string | null;
  redo: string | null;
  canUndo: boolean;
  canRedo: boolean;
}

export interface ProjectResponse {
  projectId: string;
  path: string;
  project: Project;
  history: HistoryStatus;
}

export interface DirEntry {
  name: string;
  path: string;
  type: "dir" | "project" | "file";
  size?: number;
  mtimeMs?: number;
}

export interface DirListing {
  dir: string;
  parent: string | null;
  home: string;
  entries: DirEntry[];
}

export interface ChangeEvent {
  type: "change";
  projectId: string;
  revision: number;
  kind: "apply" | "undo" | "redo";
  by: "user" | "agent";
  summary: string;
  txId: string;
}

export interface ExportJob {
  id: string;
  revision: number;
  outPath: string;
  state: "running" | "done" | "failed" | "cancelled";
  progress: number;
  encoder: string;
  durationUs: number;
  startedAt: number;
  finishedAt?: number;
  speed?: number;
  sizeBytes?: number;
  error?: string;
  /** Loudness of the finished file (LUFS) and the target it was levelled to, if any. */
  loudnessLufs?: number;
  targetLufs?: number;
}

export interface Job {
  id: string;
  kind: string;
  projectId: string;
  label: string;
  state: "running" | "done" | "failed" | "cancelled";
  progress: number;
  message: string;
  error?: string;
}

export interface Prepared {
  proxy: boolean;
  wave: boolean;
  thumbs: { intervalUs: number; cols: number; rows: number; count: number; w: number; h: number } | null;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant" | "error";
  text: string;
  at: number;
  images?: string[];
}
export interface ChatState {
  messages: ChatMessage[];
  running: boolean;
  activity: string;
}

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  lengthUs: number;
  contents: string;
}
export interface LibraryState {
  memory: string;
  templates: TemplateSummary[];
  projects: { path: string; name: string; lastOpened: string; note?: string }[];
}

export interface Thumbnail { file: string; note: string; createdAt: string; by: "user" | "agent" }
export interface PublishState {
  title: string;
  titles: string[];
  description: string;
  thumbnails: Thumbnail[];
  chosen?: string;
  lengthUs: number;
  markers: { at: string; timeUs: number; label: string }[];
}
export interface PublishSettings {
  descriptionTemplate: string;
  descriptionTemplateFile: string;
  thumbnailStyle: string;
  thumbnailRefs: string[];
  channelName: string;
  fileReadable?: boolean;
}

export type ServerEvent = { type: "publish"; projectId: string } | { type: "library" } | { type: "chat"; projectId: string; chat: ChatState } | { type: "cache"; projectId: string } | { type: "proposals"; projectId: string } | ChangeEvent | { type: "job"; job: Job } | { type: "export"; job: ExportJob };

/** Editor-wide defaults kept in preferences.json. */
export interface Prefs {
  newProjectSpeed: number;
  projectsFolder: string;
  /** Loudness new projects level to on export; null: off. */
  newProjectLufs: number | null;
}

export const api = {
  /** Sends a recorded voiceover; the server saves it in the project and returns its path. */
  uploadRecording: async (pid: string, blob: Blob, clean = true): Promise<{ path: string }> => {
    const r = await fetch(`/api/p/${pid}/recordings${clean ? "" : "?clean=0"}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": blob.type || "application/octet-stream" }, body: blob });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data as { error?: { message?: string } }).error?.message ?? `Upload failed (${r.status})`);
    return data as { path: string };
  },
  /** A picture pasted into the chat; kept in the project until the message is sent with it. */
  uploadChatImage: async (pid: string, blob: Blob): Promise<{ file: string; path: string }> => {
    const r = await fetch(`/api/p/${pid}/chat/images`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": blob.type || "application/octet-stream" }, body: blob });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data as { error?: { message?: string } }).error?.message ?? `Upload failed (${r.status})`);
    return data as { file: string; path: string };
  },
  chatImageUrl: (pid: string, file: string) => `/api/p/${pid}/chat/images/${encodeURIComponent(file)}?token=${token}`,
  projects: () => call<{ projects: { projectId: string; path: string; revision: number }[] }>("GET", "/api/projects"),
  open: (path: string, create = false) =>
    call<{ projectId: string; path: string; revision: number }>("POST", "/api/projects/open", { path, create }),
  project: (pid: string) => call<ProjectResponse>("GET", `/api/p/${pid}/project`),
  plan: (pid: string) => call<Plan>("GET", `/api/p/${pid}/plan`),
  apply: (pid: string, baseRevision: number, summary: string, ops: Op[]) =>
    call<{ txId: string; revision: number; created: (string | null)[] }>("POST", `/api/p/${pid}/transactions`, {
      baseRevision,
      by: "user",
      summary,
      ops,
    }),
  undo: (pid: string) => call<{ revision: number; summary: string }>("POST", `/api/p/${pid}/undo`),
  redo: (pid: string) => call<{ revision: number; summary: string }>("POST", `/api/p/${pid}/redo`),
  exportStart: (pid: string) => call<ExportJob>("POST", `/api/p/${pid}/export`, {}),
  exportStatus: (pid: string, jobId: string) => call<ExportJob>("GET", `/api/p/${pid}/export/${jobId}`),
  exportCancel: (pid: string, jobId: string) => call<ExportJob>("POST", `/api/p/${pid}/export/${jobId}/cancel`),
  exportList: (pid: string) => call<{ jobs: ExportJob[] }>("GET", `/api/p/${pid}/export`),
  proposals: (pid: string) => call<{ proposals: Proposal[] }>("GET", `/api/p/${pid}/proposals`),
  roughcut: (pid: string, body: { zooms?: boolean; cuts?: boolean } = {}) => call<{ job: Job }>("POST", `/api/p/${pid}/roughcut`, body),
  proposalAccept: (pid: string, id: string, itemIds?: string[]) => call<{ accepted: number; skipped: number }>("POST", `/api/p/${pid}/proposals/${id}/accept`, { itemIds }),
  proposalCreate: (pid: string, body: { by: "user" | "agent"; summary: string; items: { kind: string; label: string; ops: Op[]; savedUs: number; clipId?: string; mediaId?: string; atUs?: number }[] }) =>
    call<Proposal>("POST", `/api/p/${pid}/proposals`, body),
  proposalReject: (pid: string, id: string) => call<{ rejected: boolean }>("POST", `/api/p/${pid}/proposals/${id}/reject`, {}),
  transcripts: (pid: string) => call<{ transcripts: Transcripts; ready: boolean }>("GET", `/api/p/${pid}/transcripts`),
  transcribe: (pid: string, mediaIds?: string[], redo = false) => call<{ job: Job | null; message?: string }>("POST", `/api/p/${pid}/transcribe`, { mediaIds, redo }),
  jobs: (pid: string) => call<{ jobs: Job[] }>("GET", `/api/p/${pid}/jobs`),
  jobCancel: (pid: string, jobId: string) => call<Job>("POST", `/api/p/${pid}/jobs/${jobId}/cancel`),
  list: (dir: string) => call<DirListing>("GET", `/api/fs/list?dir=${encodeURIComponent(dir)}`),
  mediaUrl: (pid: string, mediaId: string, proxy = false) => `/api/p/${pid}/media/${encodeURIComponent(mediaId)}?token=${token}${proxy ? "&proxy=1" : ""}`,
  cache: (pid: string) => call<{ media: Record<string, Prepared> }>("GET", `/api/p/${pid}/cache`),
  wave: (pid: string, mediaId: string) => call<{ perSecond: number; peaks: string }>("GET", `/api/p/${pid}/wave/${encodeURIComponent(mediaId)}`),
  overlayUrl: (pid: string, id: string) => `/api/p/${pid}/overlays/${encodeURIComponent(id)}?token=${token}`,
  templates: (pid: string) => call<{ templates: Record<string, { description: string; defaults: Record<string, string> }> }>("GET", `/api/p/${pid}/templates`),
  overlayState: (pid: string) => call<{ rendered: Record<string, string> }>("GET", `/api/p/${pid}/overlay-state`),
  chat: (pid: string) => call<ChatState>("GET", `/api/p/${pid}/chat`),
  chatSend: (pid: string, body: { text: string; playheadUs: number; selected?: string; images?: string[] }) => call<ChatState>("POST", `/api/p/${pid}/chat`, body),
  chatStop: (pid: string) => call<{ ok: boolean }>("POST", `/api/p/${pid}/chat/stop`, {}),
  chatClear: (pid: string) => call<ChatState>("POST", `/api/p/${pid}/chat/clear`, {}),
  library: () => call<LibraryState>("GET", "/api/library"),
  saveMemory: (text: string) => call<{ memory: string }>("POST", "/api/library/memory", { text }),
  deleteTemplate: (id: string) => call<{ ok: boolean }>("POST", `/api/library/templates/${encodeURIComponent(id)}/delete`, {}),
  captureTemplate: (pid: string, body: { fromUs: number; toUs: number; name: string; description: string }) =>
    call<{ id: string; name: string; contents: string; lengthUs: number }>("POST", `/api/p/${pid}/library/capture`, body),
  insertTemplate: (pid: string, templateId: string, atUs: number) => call<{ missingFiles?: string[] }>("POST", `/api/p/${pid}/library/insert`, { templateId, atUs }),
  preferences: () => call<Prefs>("GET", "/api/preferences"),
  setPreferences: (p: Partial<Prefs>) => call<Prefs>("POST", "/api/preferences", p),
  hermesProfiles: () => call<{ profiles: string[]; current: string }>("GET", "/api/hermes/profiles"),
  setHermesProfile: (name: string) => call<{ hermesProfile: string }>("POST", "/api/preferences", { hermesProfile: name }),
  newProject: (name: string, folder?: string) => call<{ projectId: string; path: string }>("POST", "/api/projects/new", { name, ...(folder ? { folder } : {}) }),
  publish: (pid: string) => call<PublishState>("GET", `/api/p/${pid}/publish`),
  savePublish: (pid: string, patch: Partial<Pick<PublishState, "title" | "titles" | "description" | "chosen">>) => call<PublishState>("POST", `/api/p/${pid}/publish`, patch),
  addThumbnail: (pid: string, path: string) => call<PublishState>("POST", `/api/p/${pid}/publish/thumbnails`, { path, choose: true }),
  frameThumbnail: (pid: string, tlUs: number) => call<PublishState>("POST", `/api/p/${pid}/publish/thumbnails/frame`, { tlUs: Math.round(tlUs) }),
  deleteThumbnail: (pid: string, file: string) => call<PublishState>("POST", `/api/p/${pid}/publish/thumbnails/${encodeURIComponent(file)}/delete`, {}),
  thumbnailUrl: (pid: string, file: string) => `/api/p/${pid}/publish/thumbnails/${encodeURIComponent(file)}?token=${token}`,
  publishSettings: () => call<PublishSettings>("GET", "/api/library/publish"),
  savePublishSettings: (s: Partial<PublishSettings>) => call<PublishSettings>("POST", "/api/library/publish", s),
  missing: (pid: string) => call<{ missing: { mediaId: string; path: string }[] }>("GET", `/api/p/${pid}/missing`),
  srtUrl: (pid: string) => `/api/p/${pid}/captions?format=srt&token=${token}`,
  thumbsUrl: (pid: string, mediaId: string) => `/api/p/${pid}/thumbs/${encodeURIComponent(mediaId)}?token=${token}`,
  frameUrl: (pid: string, mediaId: string, us: number, width: number) =>
    `/api/p/${pid}/frame?mediaId=${encodeURIComponent(mediaId)}&us=${Math.round(us)}&width=${width}&token=${token}`,
};

/** Live change feed. Reconnects on its own. Returns a function that stops it. */
export function subscribe(onEvent: (e: ServerEvent) => void, onStatus: (connected: boolean) => void): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let timer: number | undefined;
  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?token=${token}`);
    ws.onopen = () => onStatus(true);
    ws.onmessage = (m) => {
      try {
        const e = JSON.parse(String(m.data));
        if (e && typeof e.type === "string") onEvent(e);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      onStatus(false);
      if (!stopped) timer = window.setTimeout(connect, 1000);
    };
  };
  connect();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    ws?.close();
  };
}
