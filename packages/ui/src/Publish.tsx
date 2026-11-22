import { useCallback, useEffect, useRef, useState } from "react";
import { api, subscribe, type PublishSettings, type PublishState } from "./api";
import { desktop } from "./desktop";
import { clock } from "./time";
import type { Editor } from "./useEditor";

/** Opens the chat on the left and sends Hermes a request. */
export function askHermes(editor: Editor, text: string): void {
  window.dispatchEvent(new CustomEvent("sous:left", { detail: "chat" }));
  void api.chatSend(editor.pid, { text, playheadUs: Math.round(editor.player.tlUs) }).catch((e) => editor.notify(e instanceof Error ? e.message : String(e), "error"));
}

const ASK_DESCRIPTION =
  "Write the YouTube description and 5 title options for this video. Read the publish brief first (publish tool, action brief): follow my description template, and use the times in its outline, which are already in the finished edit. Save them with the publish tool (action set). Keep chapters to the main sections.";
const ASK_THUMBNAILS =
  "Make 3 thumbnail options for this video. Read the publish brief first (publish tool, action brief) for my thumbnail style, reference pictures and the title. Grab a frame from the edit if a screenshot helps. Add each finished image with the publish tool (action add_thumbnail) and a one-line note on what is different about it.";

function duration(us: number): string {
  const s = Math.max(0, Math.round(us / 1e6));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The thumbnail, title and description for the upload. Hermes writes them
 * (from the shared templates in the Library) and the owner picks and edits.
 * The thumbnail is shown as it would appear on YouTube, at feed and sidebar size.
 */
export function Publish({ editor }: { editor: Editor }) {
  const { pid } = editor;
  const [data, setData] = useState<PublishState | null>(null);
  const [settings, setSettings] = useState<PublishSettings | null>(null);
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const dirty = useRef({ title: false, desc: false });
  const [saved, setSaved] = useState(true);
  const [retry, setRetry] = useState(0);
  const titleNow = useRef(title);
  titleNow.current = title;
  const descNow = useRef(desc);
  descNow.current = desc;
  const notify = useRef(editor.notify);
  notify.current = editor.notify;

  const load = useCallback(() => {
    void api.publish(pid).then((d) => {
      setData(d);
      if (!dirty.current.title) setTitle(d.title);
      if (!dirty.current.desc) setDesc(d.description);
    }).catch((e) => notify.current(e instanceof Error ? e.message : String(e), "error"));
    void api.publishSettings().then(setSettings).catch(() => undefined);
  }, [pid]);
  useEffect(() => load(), [load]);
  // Pictures saved straight into the thumbnails folder (by Hermes or by hand) show up without a reload.
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 4000);
    return () => window.clearInterval(t);
  }, [load]);
  useEffect(() => subscribe((e) => (e.type === "publish" && e.projectId === pid) || e.type === "library" ? load() : undefined, () => {}), [load, pid]);

  // Typing saves on its own, a moment after it stops.
  useEffect(() => {
    if (!dirty.current.title && !dirty.current.desc) return;
    setSaved(false);
    const t = window.setTimeout(() => {
      const patch: { title?: string; description?: string } = {};
      if (dirty.current.title) patch.title = title;
      if (dirty.current.desc) patch.description = desc;
      // Marked clean only once the server has it, and only for the text that was sent: a failed save,
      // or typing that came in meanwhile, stays dirty and is sent again.
      const sentTitle = patch.title, sentDesc = patch.description;
      void api.savePublish(pid, patch).then(() => {
        if (sentTitle !== undefined && titleNow.current === sentTitle) dirty.current.title = false;
        if (sentDesc !== undefined && descNow.current === sentDesc) dirty.current.desc = false;
        if (!dirty.current.title && !dirty.current.desc) setSaved(true);
      }).catch((e) => {
        notify.current(`Title and description not saved yet, trying again: ${e instanceof Error ? e.message : String(e)}`, "error");
        window.setTimeout(() => setRetry((r) => r + 1), 5000);
      });
    }, 600);
    return () => window.clearTimeout(t);
  }, [title, desc, pid, retry]);

  const copy = (text: string, what: string) => void navigator.clipboard.writeText(text).then(() => editor.notify(`Copied the ${what}`), () => editor.notify("Could not copy", "error"));
  const chosen = data?.thumbnails.find((t) => t.file === data.chosen) ?? data?.thumbnails[data.thumbnails.length - 1];
  const src = chosen ? api.thumbnailUrl(pid, chosen.file) : null;
  const len = duration(editor.plan.durationUs);
  const channel = settings?.channelName || "Your channel";
  const descLen = [...desc].length;

  return (
    <section className="publish" aria-label="Publish">
      <div className="pub-thumbs">
        <header className="pub-head">
          <h2>Thumbnail</h2>
          <span className="grow" />
          <button className="primary" onClick={() => askHermes(editor, ASK_THUMBNAILS)} disabled={editor.chat.running}>Ask Hermes for thumbnails</button>
        </header>
        <div className="pub-main">
          {src ? <img src={src} alt="Chosen thumbnail" /> : <div className="pub-empty">No thumbnail yet. Ask Hermes for options, use a frame from the video, or add a picture.</div>}
        </div>
        {chosen?.note && <p className="dim small">{chosen.note}</p>}
        <div className="row">
          <button onClick={() => void api.frameThumbnail(pid, editor.player.tlUs).then(() => load()).catch((e) => editor.notify(e.message, "error"))} disabled={editor.plan.segments.every((s) => s.trackKind !== "main")} title="Save the main video's picture at the playhead as a starting point">
            Use frame at {clock(editor.player.tlUs, 0)}
          </button>
          {desktop && (
            <button onClick={() => void desktop!.pickMedia().then(async (paths) => {
              for (const p of paths) await api.addThumbnail(pid, p).then(() => load()).catch((e) => editor.notify(e.message, "error"));
            })}>Add picture…</button>
          )}
        </div>
        {data && data.thumbnails.length > 0 && (
          <ul className="pub-variants" aria-label="Thumbnail options">
            {data.thumbnails.map((t) => (
              <li key={t.file} className={t.file === chosen?.file ? "on" : ""}>
                <button className="pick" onClick={() => void api.savePublish(pid, { chosen: t.file }).then(() => load())} title={t.note || t.file}>
                  <img src={api.thumbnailUrl(pid, t.file)} alt="" loading="lazy" />
                  {t.by === "agent" && <span className="badge">Hermes</span>}
                </button>
                <button className="x" title="Delete this option" onClick={() => { if (confirm("Delete this thumbnail option?")) void api.deleteThumbnail(pid, t.file).then(() => load()); }}>×</button>
              </li>
            ))}
          </ul>
        )}
        <h3>On YouTube</h3>
        <div className="yt-previews">
          <div className="yt-card feed">
            <div className="yt-thumb">{src ? <img src={src} alt="" /> : <div className="yt-blank" />}<span className="yt-len">{len}</span></div>
            <div className="yt-meta">
              <span className="yt-avatar" />
              <div>
                <div className="yt-title">{title || "Your title"}</div>
                <div className="yt-sub">{channel}</div>
                <div className="yt-sub">0 views · just now</div>
              </div>
            </div>
          </div>
          <div className="yt-card side">
            <div className="yt-thumb">{src ? <img src={src} alt="" /> : <div className="yt-blank" />}<span className="yt-len">{len}</span></div>
            <div>
              <div className="yt-title">{title || "Your title"}</div>
              <div className="yt-sub">{channel}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="pub-text">
        <header className="pub-head">
          <h2>Title and description</h2>
          <span className="grow" />
          <span className="dim small">{saved ? "Saved" : "Saving…"}</span>
          <button className="primary" onClick={() => askHermes(editor, ASK_DESCRIPTION)} disabled={editor.chat.running}>Ask Hermes to write it</button>
        </header>
        <label className="pub-label">
          <span>Title <span className={"dim small" + ([...title].length > 100 ? " over" : "")}>{[...title].length}/100</span></span>
          <div className="row">
            <input value={title} onChange={(e) => { dirty.current.title = true; setTitle(e.target.value); }} onKeyDown={(e) => e.stopPropagation()} placeholder="Video title" />
            <button onClick={() => copy(title, "title")} disabled={!title}>Copy</button>
          </div>
        </label>
        {data && data.titles.length > 0 && (
          <ul className="pub-titles" aria-label="Title options">
            {data.titles.map((t) => (
              <li key={t}>
                <button className={t === title ? "on" : ""} onClick={() => { dirty.current.title = true; setTitle(t); }}>{t}</button>
              </li>
            ))}
          </ul>
        )}
        <label className="pub-label grow-area">
          <span>Description <span className={"dim small" + (descLen > 5000 ? " over" : "")}>{descLen}/5000</span></span>
          <textarea value={desc} onChange={(e) => { dirty.current.desc = true; setDesc(e.target.value); }} onKeyDown={(e) => e.stopPropagation()} placeholder="Ask Hermes to write it from the transcript and your template, or type it here." />
        </label>
        <div className="row">
          <button onClick={() => copy(desc, "description")} disabled={!desc}>Copy description</button>
          <span className="dim small">Times in the description should match the finished video ({len}). Hermes reads them from the edit after cuts and speed.</span>
        </div>
        {data && (data.markers?.length ?? 0) > 0 && (
          <p className="dim small">Markers on the timeline (used as chapters when they have names): {data.markers.map((m) => `${m.at}${m.label ? ` ${m.label}` : ""}`).join(" · ")}</p>
        )}
        <p className="dim small">
          {settings && (settings.descriptionTemplate || (settings.descriptionTemplateFile && settings.fileReadable))
            ? "Hermes follows your description template and thumbnail style. "
            : "Set your description template and thumbnail style so every video starts from your format. "}
          <button className="link" onClick={() => window.dispatchEvent(new CustomEvent("sous:view", { detail: "library" }))}>Open them in Library</button>
        </p>
      </div>
    </section>
  );
}
