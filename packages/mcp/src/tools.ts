import { clipSpans, cutRangeOps, removeItemsOps, restoreItemsOps, searchSequence, sequence, sourceToTimeline, splitAtOp, type Op, type Plan, type Project, type SeqItem, type Transcripts } from "@sous-chef/core";

/** What the adapter needs from the edit server. Kept as an interface so the tools can be tested without a network. */
export interface EditApi {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  frame(path: string): Promise<{ jpeg: Buffer; mediaId: string; sourceUs: number }>;
}

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface ToolResult {
  content: Content[];
  isError?: boolean;
}

interface ProjectResponse {
  projectId: string;
  path: string;
  project: Project;
  history: { undo: string | null; redo: string | null; canUndo: boolean; canRedo: boolean };
}

/** Agent edits that remove more than this are shown to the user for approval instead of applied. */
export const PROPOSE_OVER_PIECES = 20;
export const PROPOSE_OVER_US = 30_000_000;

const TIME_NOTE = "All times are whole microseconds (1 second = 1000000).";

export const TOOLS = [
  {
    name: "project",
    description:
      "Sous Chef video editor: list open projects, open one by folder path, or read one. Read a project before editing it: the result gives an overview line, the revision, media, every track with its clips (main, voiceover, music, pictures, detached audio), main-track cuts, zooms, text and graphics. " +
      TIME_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "open", "get"], description: "list: projects open now. open: open a .sous folder by path. get: read one project." },
        project_id: { type: "string", description: "For get." },
        path: { type: "string", description: "For open: absolute path of the project folder, ending in .sous" },
        create: { type: "boolean", description: "For open: create the project if the folder does not exist." },
      },
      required: ["action"],
    },
  },
  {
    name: "edit_apply",
    description:
      "Sous Chef: apply a batch of edits to a project as one undoable step. All ops succeed or none do. Pass the revision you last read as base_revision; a stale revision is rejected and you must read the project again. " +
      TIME_NOTE +
      " Ops in timeline time (preferred for cuts): {op:'timeline.cut', startUs, endUs} removes that stretch and closes the gap; {op:'timeline.split', atUs} splits the clip under that time. " +
      "Main-track clips sit at their own start time and may leave empty space (it plays as black): {op:'clip.move', clipId, startUs} puts a clip anywhere (dropped onto another clip it goes in at the nearer edge and later clips move right); {op:'clip.remove', clipId} leaves its space empty; {op:'gap.close', atUs?} closes the gap at that time, or every gap when atUs is omitted. Cutting words or ranges inside a clip always closes up by itself. " +
      "Timelines: a project can hold several, one open at a time (the project tool lists them). {op:'timeline.add', name?} starts and opens an empty one; {op:'timeline.switch', timelineId}; {op:'timeline.rename', timelineId, name}; {op:'timeline.remove', timelineId}; {op:'timeline.insert', timelineId, atUs?} copies another timeline's whole contents into the open one at that time (the end if omitted), moving later content right. Every other op acts on the open timeline. " +
      "Ops on clips, in the source take's own time: {op:'clip.trim', clipId, sourceInUs?, sourceOutUs?}; {op:'clip.split', clipId, atSourceUs}; {op:'clip.move', clipId, index}; {op:'clip.remove', clipId}; " +
      "{op:'range.remove', clipId, startUs, endUs} cuts inside a clip; {op:'range.restore', clipId, rangeIds:[...]} brings a cut back. " +
      "Any clip on any track (voiceover, music, pictures, detached audio) is removed with {op:'clip.remove', clipId}; a whole extra track and its clips with {op:'track.remove', trackId}; {op:'track.set', trackId, name?, muted?}; {op:'media.remove', mediaId} takes an unused file out of the media bin (the file itself is never deleted). Media: {op:'media.add', media:{path}} imports a file in place; {op:'clip.add', trackId:'main', mediaId, sourceInUs?, sourceOutUs?, index?} puts it on the timeline. " +
      "Zooms, pinned to the take: {op:'zoom.add', mediaId, startUs, endUs, rect:[x,y,w,h]} where rect is fractions 0..1 of the picture (left, top, width, height); {op:'zoom.set', zoomId, ...}; {op:'zoom.remove', zoomId}. " +
      "Markers: {op:'marker.add', timeUs, label?}; {op:'marker.update', markerId, label?, timeUs?} (named markers are the video's chapters); {op:'marker.remove', markerId}. " +
      "Text over the picture, in timeline time: {op:'overlay.add', kind:'text', startUs, durationUs, text, style?:{size (fraction of picture height, default 0.06), color:'#rrggbb', bold, box}, transform?:{x, y (offsets from centre, -0.5..0.5), scale, opacity}}; {op:'overlay.set', overlayId, ...}; {op:'overlay.remove', overlayId}. Text is not moved by zooms. " +
      "HyperFrames graphics: {op:'overlay.add', kind:'hyperframes', template, params, startUs, durationUs, text (a short label for the timeline)}. Templates: 'lower-third' {title, subtitle, color}, 'callout' {text, color, x, y (pixels of its top-left on 1920x1080)}, 'title-card' {title, subtitle, color}, 'subscribe' {text, color, x, y (its middle)}, 'highlight' {color, x, y, w, h: a box drawn around part of the screen, in pixels}, 'arrow' {text, color, x, y (the tip)}, 'step' {number, text, color}, 'keys' {keys like 'Ctrl+Shift+P', color}, 'counter' {value, suffix, label, color}, 'quote' {text, author, color}, 'end-card' {title, subtitle, color: about 10 s, for YouTube end screens}; color is '#rrggbb'. Move or resize any overlay with {op:'overlay.set', overlayId, transform:{x, y, scale}} and change when it shows with startUs/durationUs. They render in the background (about 30 s each); export waits until they are ready and says so. " +
      "Transitions between main-track clips that touch: {op:'clip.set', clipId (the later clip), transitionIn:{kind:'dissolve'|'wipe'|'slide'|'zoom'|'white'|'black', durationUs (0.1-4 s, centred on the cut)}}; transitionIn:null removes it. The video keeps its length. A cut inside one clip (where a stretch was cut out) takes a transition once it is a cut between two clips: in the same edit_apply, {op:'clip.split', clipId, atSourceUs (where the later piece starts in the take), newId} then {op:'clip.set', clipId: newId, transitionIn}; the picture does not change. Use them sparingly, at changes of topic, not on every cut. " +
      "Pictures and extra video: {op:'track.add', kind:'video'|'audio'} then {op:'clip.add', trackId, mediaId, startUs (timeline time)}; pictures show for 5 s unless sourceOutUs is given; place with {op:'clip.set', clipId, transform:{x, y, scale, opacity, crop:[x,y,w,h]}, fadeInUs, fadeOutUs, volumeDb, muted}. " +
      "Speed: {op:'project.speed', speed} plays the whole main track faster or slower (new projects start at the speed in the owner's preferences); text, pictures, music and markers keep their place against the recording. Main clips are framed with {op:'clip.set', clipId, transform:{x, y, scale, crop:[x,y,w,h]}} like pictures (scale 1, x 0, y 0, crop [0,0,1,1] is full frame). " +
      "Captions come from the kept transcript words: {op:'settings.set', settings:{captions:{enabled:true, size?, position?:'bottom'|'middle'|'top', box?, uppercase?, maxWords?}}}. Fix a misheard word with {op:'word.fix', mediaId, wordId, text}. Loudness levelling on export: {op:'settings.set', settings:{audio:{normalize:true}}}.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        base_revision: { type: "integer", description: "The project revision these edits were planned against." },
        summary: { type: "string", description: "Short plain description shown to the user in the undo list, e.g. 'Cut the false start at 0:42'." },
        approved: { type: "boolean", description: "Set true only when the user has already agreed to this specific large removal." },
        ops: { type: "array", items: { type: "object", properties: { op: { type: "string" } }, required: ["op"] }, minItems: 1 },
      },
      required: ["project_id", "base_revision", "summary", "ops"],
    },
  },
  {
    name: "frame_get",
    description:
      "Sous Chef: look at one frame of the video as an image. Give timeline_us to see what plays at that point of the edit, or media_id with source_us to see a moment of a raw take. Use at decision points, not for browsing. " +
      TIME_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        timeline_us: { type: "integer" },
        media_id: { type: "string" },
        source_us: { type: "integer" },
        width: { type: "integer", description: "Image width in pixels, 160 to 1920. Default 960.", minimum: 160, maximum: 1920 },
      },
      required: ["project_id"],
    },
  },
  {
    name: "history",
    description: "Sous Chef: undo or redo the most recent step in a project, whoever made it. Returns what was reverted and the new revision.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" }, action: { type: "string", enum: ["undo", "redo"] } },
      required: ["project_id", "action"],
    },
  },
  {
    name: "transcript",
    description:
      "Sous Chef: the words spoken in the edit, in play order, each with an index. read returns a page of items as text like '12:word' (a ~ marks a removed word, [pause 1.2s] a silence); search finds a phrase and returns index ranges; transcribe starts speech-to-text for takes that have none (poll with status). To cut or restore words use edit_apply with {op:'words.remove', from, to} or {op:'words.restore', from, to}, where from and to are item indexes from the same project revision (inclusive); pauses can be removed the same way. Fix a misheard word with {op:'word.fix', mediaId, wordId, text}.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        action: { type: "string", enum: ["read", "search", "transcribe", "status"] },
        from: { type: "integer", description: "read: first item index (default 0)." },
        count: { type: "integer", description: "read: how many items (default 400, max 1500)." },
        query: { type: "string", description: "search: the phrase to find." },
        detail: { type: "boolean", description: "read: also return each item's clip, word id and times as JSON." },
      },
      required: ["project_id", "action"],
    },
  },
  {
    name: "suggest",
    description:
      "Sous Chef: suggestions that wait for the user's approval. rough_cut starts the automatic first pass (its main job is flubbed lines: where a line is fumbled and said again it removes the first attempt, found by reading the transcript; it also removes filler words, gently trims silences over 1.5 s to about 0.8 s, and proposes zooms where the user points with the mouse or the screen is changing; with cuts:false it proposes zooms only, as \"Auto zoom\", without replacing a waiting rough cut); it returns a job, and the result appears to the user as a proposal to accept or reject. list shows pending proposals. accept and reject act on one, only when the user has told you to. activity returns the moments in a take where on-screen change is confined to one area or the mouse pointer keeps moving around one area (kind 'change' or 'pointer'), with a rectangle for each: use it with frame_get and the transcript to choose zoom targets yourself.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        action: { type: "string", enum: ["rough_cut", "list", "accept", "reject", "activity"] },
        proposal_id: { type: "string", description: "For accept and reject." },
        zooms: { type: "boolean", description: "rough_cut: include zoom suggestions (default true)." },
        cuts: { type: "boolean", description: "rough_cut: include cut suggestions (default true)." },
        media_id: { type: "string", description: "activity: which take." },
        from_us: { type: "integer", description: "activity: start of the source range (optional)." },
        to_us: { type: "integer", description: "activity: end of the source range (optional)." },
      },
      required: ["project_id", "action"],
    },
  },
  {
    name: "library",
    description:
      "Sous Chef: what carries over between projects. memory_read / memory_write: your editor memory, a short markdown note of how the owner edits (style, usual structure, recurring elements, corrections they made to your work); rewrite it whole with memory_write when you learn something durable, keep it under about 60 lines, and never put secrets in it. " +
      "templates_list / template_get: reusable timeline pieces (intro, outro, lower third, picture-in-picture layout) saved from earlier projects. template_save saves a stretch of a project's open timeline (from_us to to_us, timeline time) as a template with a name and a one-line description of when to use it. " +
      "template_insert drops a template into a project at at_us as one undo step: text, graphics, pictures and sound sit on top without moving anything; a template with main-track clips (an intro video) makes room by moving later content right. template_delete removes one. " +
      "project_note: one line about what this project is and what was done, shown to you in later projects. preferences_set: new_project_speed is the speed new projects start at. " +
      TIME_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["memory_read", "memory_write", "templates_list", "template_get", "template_save", "template_insert", "template_delete", "project_note", "preferences_get", "preferences_set"] },
        project_id: { type: "string", description: "For template_save, template_insert and project_note." },
        text: { type: "string", description: "memory_write: the whole new memory, markdown." },
        template_id: { type: "string" },
        name: { type: "string", description: "template_save: short name." },
        description: { type: "string", description: "template_save: when to use it." },
        from_us: { type: "integer" },
        to_us: { type: "integer" },
        at_us: { type: "integer", description: "template_insert: timeline time; the end of the main track if omitted." },
        note: { type: "string", description: "project_note: one line." },
        new_project_speed: { type: "number" },
      },
      required: ["action"],
    },
  },
  {
    name: "publish",
    description:
      "Sous Chef: the YouTube upload for a project, shown to the owner in the editor's Publish view. brief returns everything needed in one read: the owner's description template, thumbnail style and reference pictures, the channel name, the finished length, named markers, the current title/description/thumbnails, and an outline of what is said with times in the FINISHED video (after cuts and speed), which can be used as chapter times as they are. " +
      "set saves title, titles (a list of options to pick from) and/or description; the owner sees it at once. add_thumbnail copies a finished picture (absolute path to .png/.jpg/.webp) into the project's thumbnail options with a one-line note; choose=true makes it the picked one. grab_frame saves the main video's picture at at_us (timeline time) as an option and returns its path, useful as a screenshot for a thumbnail. choose picks a thumbnail by file name; remove deletes one. " +
      "settings_get / settings_set: the shared templates (description_template text, description_template_file path, thumbnail_style, thumbnail_refs, channel_name); change them only when the owner asks.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        action: { type: "string", enum: ["brief", "get", "set", "add_thumbnail", "grab_frame", "choose", "remove", "settings_get", "settings_set"] },
        title: { type: "string" },
        titles: { type: "array", items: { type: "string" } },
        description: { type: "string" },
        path: { type: "string", description: "add_thumbnail: absolute path of the picture." },
        note: { type: "string" },
        choose: { type: "boolean" },
        file: { type: "string", description: "choose/remove: the thumbnail's file name." },
        at_us: { type: "integer", description: "grab_frame: timeline time." },
        description_template: { type: "string" },
        description_template_file: { type: "string" },
        thumbnail_style: { type: "string" },
        thumbnail_refs: { type: "array", items: { type: "string" } },
        channel_name: { type: "string" },
      },
      required: ["action"],
    },
  },
  {
    name: "render",
    description:
      "Sous Chef: export the edited video to a file. start returns at once with a job id; poll status until state is done (progress is 0..1), then report output path and size. cancel stops it. The export freezes the project as it was when started. Without a path it is saved in the project's exports folder.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        action: { type: "string", enum: ["start", "status", "cancel"] },
        job_id: { type: "string", description: "For status and cancel." },
        path: { type: "string", description: "For start: optional absolute output path ending in .mp4" },
        from_us: { type: "integer", description: "For start: render only from this timeline time (for a quick check of one part)." },
        to_us: { type: "integer", description: "For start: render only up to this timeline time." },
      },
      required: ["project_id", "action"],
    },
  },
] as const;

const sec = (us: number) => (us / 1_000_000).toFixed(2) + "s";
const text = (value: unknown): ToolResult => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });

/** A compact picture of a project: enough to plan edits, without the raw file. */
export function summarize(res: ProjectResponse, plan: Plan) {
  const { project } = res;
  const spans = clipSpans(plan);
  const main = project.tracks.find((t) => t.kind === "main");
  const clips = (main?.items ?? []).flatMap((id) => {
    const clip = project.items[id];
    if (!clip || clip.type !== "clip") return [];
    const span = spans.get(id);
    return [
      {
        id,
        mediaId: clip.mediaId,
        sourceInUs: clip.sourceInUs,
        sourceOutUs: clip.sourceOutUs,
        timelineStartUs: span?.startUs ?? null,
        timelineEndUs: span?.endUs ?? null,
        cuts: clip.removed.map((r) => ({ id: r.id, startUs: r.startUs, endUs: r.endUs, by: r.by })),
      },
    ];
  });
  const fileOf = new Map(project.media.map((m) => [m.id, m.path.replace(/\\/g, "/").split("/").pop() ?? m.path]));
  const isVoice = (name: string, file: string) => /^voiceover/i.test(name) || /^voiceover-/i.test(file);
  // Every track of the open timeline, top to bottom, with what sits on it.
  const tracks = project.tracks.map((t) => {
    const items = t.items.flatMap((id) => {
      const c = project.items[id];
      if (c?.type !== "clip") return [];
      const span = spans.get(id);
      const file = fileOf.get(c.mediaId) ?? c.mediaId;
      const startUs = t.kind === "main" ? (span?.startUs ?? c.startUs) : c.startUs;
      const endUs = t.kind === "main" ? (span?.endUs ?? c.startUs) : c.startUs + Math.round((c.sourceOutUs - c.sourceInUs) / (c.speed > 0 ? c.speed : 1));
      return [{ id, file, at: `${sec(startUs)} to ${sec(endUs)}`, startUs, endUs, ...(c.muted ? { muted: true } : {}), ...(isVoice("", file) ? { voiceover: true } : {}) }];
    });
    const voice = items.length > 0 && items.every((i) => "voiceover" in i);
    return { id: t.id, kind: t.kind, name: t.name, ...(t.muted ? { muted: true } : {}), ...(voice || /^voiceover/i.test(t.name) ? { holds: "voiceover recordings" } : {}), clipCount: t.kind === "overlay" ? t.items.length : items.length, ...(t.kind === "overlay" ? { note: "text and graphics, listed in overlays" } : t.kind === "main" ? { note: "detail in mainClips" } : { clips: items }) };
  });
  const overview =
    `Timeline "${project.timelineName ?? "Timeline 1"}", ${sec(plan.durationUs)} long. Tracks: ` +
    tracks.map((t) => `${t.name} (${t.kind}, ${t.clipCount} ${t.kind === "overlay" ? "item" : "clip"}${t.clipCount === 1 ? "" : "s"}${"holds" in t ? ", voiceover" : ""})`).join("; ") +
    `. Zooms: ${Object.values(project.items).filter((i) => i.type === "zoom").length}. Text and graphics: ${Object.values(project.items).filter((i) => i.type === "overlay").length}.`;
  return {
    overview,
    projectId: res.projectId,
    path: res.path,
    revision: project.revision,
    durationUs: plan.durationUs,
    duration: sec(plan.durationUs),
    picture: `${plan.width}x${plan.height} at ${plan.fps} fps`,
    mainSpeed: project.settings.mainSpeed ?? 1,
    media: project.media.map((m) => ({ id: m.id, path: m.path, kind: m.kind, durationUs: m.durationUs })),
    mainClips: clips,
    zooms: Object.values(project.items).filter((i) => i.type === "zoom"),
    overlays: Object.values(project.items).filter((i) => i.type === "overlay").map((o) => o.type === "overlay" ? { id: o.id, kind: o.kind, startUs: o.startUs, durationUs: o.durationUs, text: o.text, template: o.template } : o),
    tracks,
    captions: project.settings.captions,
    timeline: { id: project.timelineId, name: project.timelineName, note: "Everything listed here belongs to this timeline." },
    otherTimelines: (project.timelines ?? []).map((t) => ({ id: t.id, name: t.name, clips: Object.values(t.items).filter((i) => i.type === "clip").length })),
    markers: project.markers,
    undo: res.history.undo,
    redo: res.history.redo,
    note: "Read overview and tracks first: clips live on several tracks, not only the main one. mainClips play in the order listed; sourceIn/Out and cuts are in the take's own time, timelineStart/End are positions in the edit. Remove any clip on any track with clip.remove.",
  };
}

/** Turns the timeline-time and transcript-index ops into ops on clips; everything else passes through. */
export function expandOps(ops: unknown[], plan: Plan, project?: Project, seq?: SeqItem[]): Op[] {
  const out: Op[] = [];
  for (const raw of ops) {
    const op = raw as Record<string, unknown>;
    if (op.op === "timeline.cut") {
      const a = Number(op.startUs);
      const b = Number(op.endUs);
      if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) throw new Error("timeline.cut needs different startUs and endUs");
      const made = cutRangeOps(plan, a, b);
      if (!made.length) throw new Error(`timeline.cut ${sec(a)} to ${sec(b)} covers nothing on the main track (the edit is ${sec(plan.durationUs)} long)`);
      out.push(...made);
    } else if (op.op === "timeline.split") {
      const made = splitAtOp(plan, Number(op.atUs));
      if (!made) throw new Error(`timeline.split at ${sec(Number(op.atUs))}: no clip there, or it is already a clip edge`);
      out.push(made);
    } else if (op.op === "words.remove" || op.op === "words.restore") {
      if (!project || !seq) throw new Error(`${op.op} needs the transcript; transcribe the project first`);
      const a = Number(op.from);
      const b = Number(op.to ?? op.from);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b >= seq.length || a > b) {
        throw new Error(`${op.op}: from and to must be item indexes between 0 and ${seq.length - 1}`);
      }
      const why = typeof op.why === "string" ? (op.why as never) : "user";
      out.push(...(op.op === "words.remove" ? removeItemsOps(project, seq, a, b, why) : restoreItemsOps(project, seq, a, b)));
    } else {
      out.push(raw as Op);
    }
  }
  return out;
}

export async function callTool(api: EditApi, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const pid = typeof args.project_id === "string" ? encodeURIComponent(args.project_id) : "";
  const needPid = () => {
    if (!pid) throw new Error("project_id is required. Use project with action 'list' to find it.");
  };
  const read = async () => {
    const [res, plan] = await Promise.all([api.get<ProjectResponse>(`/api/p/${pid}/project`), api.get<Plan>(`/api/p/${pid}/plan`)]);
    return summarize(res, plan);
  };

  if (name === "project") {
    if (args.action === "list") return text(await api.get("/api/projects"));
    if (args.action === "open") {
      if (typeof args.path !== "string" || !args.path) throw new Error("path is required to open a project");
      return text(await api.post("/api/projects/open", { path: args.path, create: Boolean(args.create) }));
    }
    if (args.action === "get") {
      needPid();
      return text(await read());
    }
    throw new Error("action must be list, open or get");
  }

  if (name === "edit_apply") {
    needPid();
    if (!Array.isArray(args.ops) || args.ops.length === 0) throw new Error("ops must be a non-empty list");
    if (!Number.isInteger(args.base_revision)) throw new Error("base_revision is required: read the project first");
    const plan = await api.get<Plan>(`/api/p/${pid}/plan`);
    if (plan.revision !== args.base_revision) {
      throw new Error(`stale_revision: the project is at revision ${plan.revision}, not ${args.base_revision}. Read it again and re-plan.`);
    }
    const needsWords = args.ops.some((o) => typeof (o as { op?: string })?.op === "string" && (o as { op: string }).op.startsWith("words."));
    let project: Project | undefined;
    let seq: SeqItem[] | undefined;
    if (needsWords) {
      project = (await api.get<ProjectResponse>(`/api/p/${pid}/project`)).project;
      seq = sequence(project, (await api.get<{ transcripts: Transcripts }>(`/api/p/${pid}/transcripts`)).transcripts);
    }
    const ops = expandOps(args.ops, plan, project, seq);
    if (!ops.length) return text({ applied: 0, revision: plan.revision, note: "Nothing to change: those items are already in that state." });
    // Large removals go to the user as a proposal instead of being applied.
    const removals = ops.filter((o) => o.op === "range.remove" || o.op === "clip.remove");
    const removedUs = ops.reduce((sum, o) => sum + (o.op === "range.remove" ? o.endUs - o.startUs : 0), 0);
    if (!args.approved && (removals.length > PROPOSE_OVER_PIECES || removedUs > PROPOSE_OVER_US || removals.some((o) => o.op === "clip.remove" && removals.length > 3))) {
      const proposal = await api.post<{ id: string }>(`/api/p/${pid}/proposals`, {
        by: "agent",
        summary: String(args.summary ?? "Edit by Hermes").slice(0, 200),
        items: [{ kind: "other", label: String(args.summary ?? "Edit by Hermes").slice(0, 200), savedUs: removedUs, ops }],
      });
      return text({
        applied: 0,
        proposed: true,
        proposal_id: proposal.id,
        note: `This removes ${removals.length} piece(s), ${sec(removedUs)} in total, which is over the limit for applying directly. It is now shown to the user as a suggestion to accept or reject in the editor. Tell them, and do not accept it yourself unless they say so.`,
      });
    }
    const before = plan.durationUs;
    const result = await api.post<{ revision: number; created?: unknown }>(`/api/p/${pid}/transactions`, {
      baseRevision: args.base_revision,
      by: "agent",
      summary: String(args.summary ?? "Edit by Hermes").slice(0, 200),
      ops,
    });
    const after = await read();
    return text({
      applied: ops.length,
      revision: result.revision,
      created: result.created,
      durationBefore: sec(before),
      durationAfter: after.duration,
      project: after,
    });
  }

  if (name === "frame_get") {
    needPid();
    const width = Math.max(160, Math.min(1920, Number(args.width ?? 960) || 960));
    let query: string;
    if (Number.isFinite(Number(args.timeline_us)) && args.timeline_us !== undefined) query = `tlUs=${Math.round(Number(args.timeline_us))}`;
    else if (typeof args.media_id === "string" && args.source_us !== undefined) {
      query = `mediaId=${encodeURIComponent(args.media_id)}&us=${Math.round(Number(args.source_us))}`;
    } else throw new Error("give timeline_us, or media_id with source_us");
    const frame = await api.frame(`/api/p/${pid}/frame?${query}&width=${width}`);
    return {
      content: [
        { type: "image", data: frame.jpeg.toString("base64"), mimeType: "image/jpeg" },
        { type: "text", text: JSON.stringify({ mediaId: frame.mediaId, sourceUs: frame.sourceUs, source: sec(frame.sourceUs), width }) },
      ],
    };
  }

  if (name === "history") {
    needPid();
    if (args.action !== "undo" && args.action !== "redo") throw new Error("action must be undo or redo");
    const result = await api.post<Record<string, unknown>>(`/api/p/${pid}/${args.action}`);
    return text({ ...result, project: await read() });
  }

  if (name === "transcript") {
    needPid();
    if (args.action === "transcribe") return text(await api.post(`/api/p/${pid}/transcribe`, {}));
    if (args.action === "status") return text(await api.get(`/api/p/${pid}/jobs`));
    const [res, plan, tr] = await Promise.all([
      api.get<ProjectResponse>(`/api/p/${pid}/project`),
      api.get<Plan>(`/api/p/${pid}/plan`),
      api.get<{ transcripts: Transcripts; ready: boolean }>(`/api/p/${pid}/transcripts`),
    ]);
    const seq = sequence(res.project, tr.transcripts);
    if (!seq.length) {
      return text({ revision: res.project.revision, items: 0, note: tr.ready ? "No transcript yet. Call transcript with action 'transcribe', then poll 'status'." : "Transcription is not set up on this computer." });
    }
    const where = (it: SeqItem) => sourceToTimeline(plan, it.mediaId, it.startUs + 1000);
    if (args.action === "search") {
      const hits = searchSequence(seq, String(args.query ?? ""));
      return text({
        revision: res.project.revision,
        matches: hits.slice(0, 100).map(([a, b]) => ({ from: a, to: b, text: seq.slice(a, b + 1).map((i) => i.text).join(" "), removed: seq[a]!.removed, timelineUs: where(seq[a]!) })),
        total: hits.length,
      });
    }
    if (args.action === "read") {
      const from = Math.max(0, Number(args.from ?? 0) || 0);
      const count = Math.max(1, Math.min(1500, Number(args.count ?? 400) || 400));
      const page = seq.slice(from, from + count);
      const line = page.map((it, k) => (it.kind === "pause" ? `${from + k}:[pause ${it.text}]${it.removed ? "~" : ""}` : `${from + k}:${it.removed ? "~" : ""}${it.text}`)).join(" ");
      return text({
        revision: res.project.revision,
        items: seq.length,
        from,
        to: from + page.length - 1,
        more: from + page.length < seq.length,
        firstTimelineUs: page.length ? where(page.find((i) => !i.removed) ?? page[0]!) : null,
        text: line,
        ...(args.detail ? { detail: page.map((it, k) => ({ i: from + k, kind: it.kind, clipId: it.clipId, mediaId: it.mediaId, wordId: it.wordId, startUs: it.startUs, endUs: it.endUs, removed: it.removed, timelineUs: where(it) })) } : {}),
      });
    }
    throw new Error("action must be read, search, transcribe or status");
  }

  if (name === "suggest") {
    needPid();
    if (args.action === "rough_cut") return text(await api.post(`/api/p/${pid}/roughcut`, { by: "agent", zooms: args.zooms !== false, cuts: args.cuts !== false }));
    if (args.action === "list") {
      const r = await api.get<{ proposals: { id: string; by: string; summary: string; items: { kind: string; label: string; savedUs: number }[] }[] }>(`/api/p/${pid}/proposals`);
      return text({ proposals: r.proposals.map((p) => ({ id: p.id, by: p.by, summary: p.summary, items: p.items.length, sample: p.items.slice(0, 12).map((i) => `${i.kind}: ${i.label}`) })) });
    }
    if (args.action === "activity") {
      if (typeof args.media_id !== "string") throw new Error("media_id is required for activity");
      const q = [args.from_us !== undefined ? `fromUs=${Number(args.from_us)}` : "", args.to_us !== undefined ? `toUs=${Number(args.to_us)}` : ""].filter(Boolean).join("&");
      return text(await api.get(`/api/p/${pid}/activity/${encodeURIComponent(args.media_id)}${q ? `?${q}` : ""}`));
    }
    if (typeof args.proposal_id !== "string" || !args.proposal_id) throw new Error("proposal_id is required");
    if (args.action === "accept" || args.action === "reject") return text(await api.post(`/api/p/${pid}/proposals/${encodeURIComponent(args.proposal_id)}/${args.action}`, {}));
    throw new Error("action must be rough_cut, list, accept, reject or activity");
  }

  if (name === "library") {
    const a = args.action;
    if (a === "memory_read") return text((await api.get<{ memory: string }>("/api/library")).memory || "(empty)");
    if (a === "memory_write") {
      if (typeof args.text !== "string") throw new Error("text is required");
      await api.post("/api/library/memory", { text: args.text });
      return text("Saved the editor memory.");
    }
    if (a === "templates_list") return text((await api.get<{ templates: unknown[] }>("/api/library")).templates);
    if (a === "template_get") return text(await api.get(`/api/library/templates/${encodeURIComponent(String(args.template_id ?? ""))}`));
    if (a === "template_delete") return text(await api.post(`/api/library/templates/${encodeURIComponent(String(args.template_id ?? ""))}/delete`, {}));
    if (a === "template_save") {
      needPid();
      return text(await api.post(`/api/p/${pid}/library/capture`, { fromUs: args.from_us, toUs: args.to_us, name: args.name, description: args.description }));
    }
    if (a === "template_insert") {
      needPid();
      return text(await api.post(`/api/p/${pid}/library/insert`, { templateId: args.template_id, atUs: args.at_us, by: "agent" }));
    }
    if (a === "project_note") {
      needPid();
      return text(await api.post(`/api/p/${pid}/library/note`, { note: args.note }));
    }
    if (a === "preferences_get") return text(await api.get("/api/preferences"));
    if (a === "preferences_set") return text(await api.post("/api/preferences", { newProjectSpeed: args.new_project_speed }));
    throw new Error("Unknown library action");
  }

  if (name === "publish") {
    const a = args.action;
    if (a === "settings_get") return text(await api.get("/api/library/publish"));
    if (a === "settings_set") {
      const body: Record<string, unknown> = {};
      if (args.description_template !== undefined) body.descriptionTemplate = args.description_template;
      if (args.description_template_file !== undefined) body.descriptionTemplateFile = args.description_template_file;
      if (args.thumbnail_style !== undefined) body.thumbnailStyle = args.thumbnail_style;
      if (args.thumbnail_refs !== undefined) body.thumbnailRefs = args.thumbnail_refs;
      if (args.channel_name !== undefined) body.channelName = args.channel_name;
      return text(await api.post("/api/library/publish", body));
    }
    needPid();
    if (a === "brief") return text(await api.get(`/api/p/${pid}/publish/brief`));
    if (a === "get") return text(await api.get(`/api/p/${pid}/publish`));
    if (a === "set") {
      const body: Record<string, unknown> = {};
      for (const k of ["title", "titles", "description"] as const) if (args[k] !== undefined) body[k] = args[k];
      if (!Object.keys(body).length) throw new Error("Give title, titles or description");
      const r = await api.post<{ title: string; titles: string[]; description: string }>(`/api/p/${pid}/publish`, body);
      return text({ saved: Object.keys(body), title: r.title, titles: r.titles.length, descriptionChars: r.description.length });
    }
    if (a === "add_thumbnail") return text(await api.post(`/api/p/${pid}/publish/thumbnails`, { path: args.path, note: args.note, choose: args.choose, by: "agent" }));
    if (a === "grab_frame") return text(await api.post(`/api/p/${pid}/publish/thumbnails/frame`, { tlUs: args.at_us, note: args.note, by: "agent" }));
    if (a === "choose") return text(await api.post(`/api/p/${pid}/publish`, { chosen: args.file }));
    if (a === "remove") return text(await api.post(`/api/p/${pid}/publish/thumbnails/${encodeURIComponent(String(args.file ?? ""))}/delete`, {}));
    throw new Error("Unknown publish action");
  }

  if (name === "render") {
    needPid();
    if (args.action === "start") {
      const body: Record<string, unknown> = {};
      if (typeof args.path === "string" && args.path) body.path = args.path;
      if (args.from_us !== undefined) body.fromUs = Number(args.from_us);
      if (args.to_us !== undefined) body.toUs = Number(args.to_us);
      return text(await api.post(`/api/p/${pid}/export`, body));
    }
    if (typeof args.job_id !== "string" || !args.job_id) throw new Error("job_id is required for status and cancel");
    const job = encodeURIComponent(args.job_id);
    if (args.action === "status") return text(await api.get(`/api/p/${pid}/export/${job}`));
    if (args.action === "cancel") return text(await api.post(`/api/p/${pid}/export/${job}/cancel`));
    throw new Error("action must be start, status or cancel");
  }

  throw new Error(`Unknown tool: ${name}`);
}
