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
export interface ThumbRef {
  file: string;
  use: "theme" | "include";
}

export interface PublishState {
  /** Where this video's reference pictures live (sent with the full read only). */
  referencesDir?: string;
  thumbInstructions: string;
  thumbRefs: ThumbRef[];
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

/** A video kept in the library by its path, for pointing Hermes at. */
export type BrollEngine = "local" | "cloud";
export type BrollKind = "image" | "video";
export interface BrollItem {
  id: string;
  engine: BrollEngine;
  kind: BrollKind;
  prompt: string;
  status: "working" | "done" | "failed";
  createdAt: string;
  progress?: number;
  error?: string;
  path?: string;
  durationUs?: number;
  width?: number | null;
  height?: number | null;
}
export interface BrollSettings {
  studioUrl: string;
  hasKey: boolean;
}

export interface Reference {
  id: string;
  path: string;
  name: string;
  note: string;
  addedAt: string;
  durationUs: number;
  width: number | null;
  height: number | null;
  missing?: boolean;
}

export type ServerEvent = { type: "publish"; projectId: string } | { type: "library" } | { type: "broll" } | { type: "chat"; projectId: string; chat: ChatState } | { type: "cache"; projectId: string } | { type: "proposals"; projectId: string } | ChangeEvent | { type: "job"; job: Job } | { type: "export"; job: ExportJob };

/** Editor-wide defaults kept in preferences.json. */
export interface Prefs {
  newProjectSpeed: number;
  projectsFolder: string;
  /** Loudness new projects level to on export; null: off. */
  newProjectLufs: number | null;
}

/** Settings → Remote agents. */
export interface RemoteView {
  enabled: boolean;
  port: number;
  publicUrl: string;
  status: { running: boolean; port: number; error: string };
  keys: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[];
  chatAgent: { url: string; hasKey: boolean } | null;
}

export const api = {
  remote: () => call<RemoteView>("GET", "/api/remote"),
  setRemote: (patch: { enabled?: boolean; publicUrl?: string }) => call<RemoteView>("POST", "/api/remote", patch),
  checkRemote: () => call<{ ok: boolean; message: string }>("POST", "/api/remote/check", {}),
  makeAgentKey: (name: string) => call<{ key: string; id: string; name: string }>("POST", "/api/remote/keys", { name }),
  removeAgentKey: (id: string) => call<RemoteView>("POST", `/api/remote/keys/${encodeURIComponent(id)}/delete`, {}),
  setChatAgent: (agent: { url: string; key?: string } | null) => call<RemoteView>("POST", "/api/remote/agent", agent ?? { off: true }),
  testChatAgent: () => call<{ ok: boolean; reached: boolean; tools: boolean; message: string }>("POST", "/api/remote/agent/test", {}),
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
  /** Words from a chat recording, by the chosen Hermes profile's own speech-to-text. */
  hearSpeech: async (blob: Blob): Promise<string> => {
    const r = await fetch("/api/talk/transcribe", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": blob.type || "audio/webm" }, body: blob });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data as { error?: { message?: string } }).error?.message ?? `Transcription failed (${r.status})`);
    return String((data as { text?: string }).text ?? "");
  },
  /** A reply read aloud in the chosen Hermes profile's voice. */
  speak: async (text: string): Promise<Blob> => {
    const r = await fetch("/api/talk/speak", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error((data as { error?: { message?: string } }).error?.message ?? `Speech failed (${r.status})`);
    }
    return r.blob();
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
  chatSend: (pid: string, body: { text: string; playheadUs: number; selected?: string; images?: string[]; marks?: string }) => call<ChatState>("POST", `/api/p/${pid}/chat`, body),
  chatStop: (pid: string) => call<{ ok: boolean }>("POST", `/api/p/${pid}/chat/stop`, {}),
  chatClear: (pid: string) => call<ChatState>("POST", `/api/p/${pid}/chat/clear`, {}),
  library: () => call<LibraryState>("GET", "/api/library"),
  references: () => call<{ references: Reference[] }>("GET", "/api/library/references"),
  broll: () => call<{ items: BrollItem[]; settings: BrollSettings }>("GET", "/api/library/broll"),
  makeBroll: (engine: BrollEngine, kind: BrollKind, prompt: string) => call<BrollItem>("POST", "/api/library/broll", { engine, kind, prompt }),
  cancelBroll: (id: string) => call<{ ok: boolean }>("POST", `/api/library/broll/${encodeURIComponent(id)}/cancel`, {}),
  removeBroll: (id: string) => call<{ ok: boolean }>("POST", `/api/library/broll/${encodeURIComponent(id)}/delete`, {}),
  brollThumbUrl: (id: string) => `/api/library/broll/${encodeURIComponent(id)}/thumb?token=${token}`,
  saveBrollSettings: (patch: { studioUrl?: string; key?: string }) => call<BrollSettings>("POST", "/api/library/broll/settings", patch),
  checkStudio: () => call<{ ok: boolean; message: string }>("POST", "/api/library/broll/check", {}),
  addReference: (path: string, note = "") => call<Reference>("POST", "/api/library/references", { path, note }),
  updateReference: (id: string, patch: { note?: string; name?: string }) => call<Reference>("POST", `/api/library/references/${encodeURIComponent(id)}`, patch),
  removeReference: (id: string) => call<{ ok: boolean }>("POST", `/api/library/references/${encodeURIComponent(id)}/delete`, {}),
  referenceThumbUrl: (id: string) => `/api/library/references/${encodeURIComponent(id)}/thumb?token=${token}`,
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
  savePublish: (pid: string, patch: Partial<Pick<PublishState, "title" | "titles" | "description" | "chosen" | "thumbInstructions" | "thumbRefs">>) => call<PublishState>("POST", `/api/p/${pid}/publish`, patch),
  addThumbnail: (pid: string, path: string) => call<PublishState>("POST", `/api/p/${pid}/publish/thumbnails`, { path, choose: true }),
  frameThumbnail: (pid: string, tlUs: number) => call<PublishState>("POST", `/api/p/${pid}/publish/thumbnails/frame`, { tlUs: Math.round(tlUs) }),
  addThumbRef: async (pid: string, blob: Blob): Promise<PublishState> => {
    const r = await fetch(`/api/p/${pid}/publish/references`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": blob.type || "application/octet-stream" }, body: blob });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body?.error?.message ?? `Could not add the picture (${r.status})`);
    return body as PublishState;
  },
  removeThumbRef: (pid: string, file: string) => call<PublishState>("POST", `/api/p/${pid}/publish/references/${encodeURIComponent(file)}/delete`, {}),
  thumbRefUrl: (pid: string, file: string) => `/api/p/${pid}/publish/references/${encodeURIComponent(file)}?token=${token}`,
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
