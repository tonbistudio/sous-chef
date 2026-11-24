import { useCallback, useEffect, useRef, useState } from "react";
import { api, subscribe, type PublishSettings, type PublishState, type ThumbRef } from "./api";
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
/** The one-click thumbnail request: my template, this video's title, my instructions and my pictures. */
function thumbnailPrompt(title: string, instructions: string, refs: { path: string; use: ThumbRef["use"] }[]): string {
  const lines = [
    "Make 3 thumbnail options for this video.",
    "1. Template: read the publish brief first (publish tool, action brief) and follow my thumbnail template from the Library (thumbnailStyle and its reference pictures).",
    title.trim() ? `2. Title: "${title.trim()}". The thumbnail goes with this title: complement it, don't just repeat it word for word.` : "2. Title: none yet; work from what the video is about.",
    instructions.trim() ? `3. My instructions for this one:\n${instructions.trim()}` : "3. No extra instructions for this one.",
  ];
  if (refs.length) {
    lines.push("4. My reference pictures for this video (look at each one with your vision tool before you start):");
    for (const r of refs) {
      lines.push(r.use === "include"
        ? `- ${r.path}: INCLUDE this picture in the thumbnail as it is (cut out or placed, not redrawn or reimagined).`
        : `- ${r.path}: THEME: borrow its look (colours, mood, style, composition). Don't copy it.`);
    }
  } else lines.push("4. No reference pictures for this one.");
  lines.push("Grab a frame from the edit if a screenshot helps. Add each finished image with the publish tool (action add_thumbnail) and a one-line note on what is different about it.");
  return lines.join("\n");
}

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
        </header>
        {data && <ThumbBrief editor={editor} data={data} title={title} onChange={(d) => setData((o) => ({ ...(o ?? d), ...d }))} />}
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

/**
 * What this video's thumbnail should be: the title (from the field on the right), reference pictures
 * (paste, drop or add; each used for its look or put in as it is) and instructions, then one button.
 */
function ThumbBrief({ editor, data, title, onChange }: { editor: Editor; data: PublishState; title: string; onChange: (d: PublishState) => void }) {
  const { pid } = editor;
  const [text, setText] = useState(data.thumbInstructions);
  const [busy, setBusy] = useState(0);
  const [dropping, setDropping] = useState(false);
  const typed = useRef(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!typed.current) setText(data.thumbInstructions);
  }, [data.thumbInstructions]);
  const fail = (e: unknown) => editor.notify(e instanceof Error ? e.message : String(e), "error");
  const saveText = async (): Promise<void> => {
    if (!typed.current) return;
    const d = await api.savePublish(pid, { thumbInstructions: text });
    typed.current = false;
    onChange(d);
  };
  const add = async (files: File[]) => {
    const pics = files.filter((f) => /^image\/(png|jpeg|webp)$/.test(f.type));
    if (files.length && !pics.length) return editor.notify("References must be PNG, JPEG or WebP pictures.", "error");
    for (const f of pics) {
      setBusy((n) => n + 1);
      try {
        onChange(await api.addThumbRef(pid, f));
      } catch (e) {
        fail(e);
      } finally {
        setBusy((n) => n - 1);
      }
    }
  };
  const setUse = (f: string, use: ThumbRef["use"]) =>
    void api.savePublish(pid, { thumbRefs: data.thumbRefs.map((r) => (r.file === f ? { ...r, use } : r)) }).then(onChange).catch(fail);
  const make = async () => {
    try {
      await saveText();
      const dir = data.referencesDir ?? (await api.publish(pid)).referencesDir ?? "publish/references";
      const refs = data.thumbRefs.map((r) => ({ path: `${dir}/${r.file}`, use: r.use }));
      askHermes(editor, thumbnailPrompt(title, text, refs));
    } catch (e) {
      fail(e);
    }
  };
  return (
    <div
      className={"thumb-brief" + (dropping ? " dropping" : "")}
      onPaste={(e) => {
        const files = Array.from(e.clipboardData.files);
        if (files.length) {
          e.preventDefault();
          void add(files);
        }
      }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDropping(true); } }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => { e.preventDefault(); setDropping(false); void add(Array.from(e.dataTransfer.files)); }}
    >
      <div className="tb-row">
        <span className="tb-step">1</span>
        <div className="tb-body">
          <strong>Title</strong>
          <span className={title.trim() ? "tb-title" : "dim small"}>{title.trim() || "No title yet. Type it in Title on the right."}</span>
        </div>
      </div>
      <div className="tb-row">
        <span className="tb-step">2</span>
        <div className="tb-body">
          <strong>Reference photos <span className="dim small">paste (Ctrl+V), drop or add. Theme: borrow its look. Include: put it in as it is.</span></strong>
          <ul className="tb-refs">
            {data.thumbRefs.map((r) => (
              <li key={r.file}>
                <img src={api.thumbRefUrl(pid, r.file)} alt="" />
                <div className="tb-use" role="radiogroup" aria-label="How to use this picture">
                  <button role="radio" aria-checked={r.use === "theme"} className={r.use === "theme" ? "on" : ""} onClick={() => setUse(r.file, "theme")}>Theme</button>
                  <button role="radio" aria-checked={r.use === "include"} className={r.use === "include" ? "on" : ""} onClick={() => setUse(r.file, "include")}>Include</button>
                </div>
                <button className="x" title="Remove this picture" onClick={() => void api.removeThumbRef(pid, r.file).then(onChange).catch(fail)}>×</button>
              </li>
            ))}
            {data.thumbRefs.length < 8 && (
              <li className="tb-add">
                <button onClick={() => file.current?.click()} disabled={busy > 0}>{busy ? "Adding…" : "+ Add photo"}</button>
              </li>
            )}
          </ul>
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => { void add(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
        </div>
      </div>
      <div className="tb-row">
        <span className="tb-step">3</span>
        <div className="tb-body">
          <strong>Instructions</strong>
          <textarea
            rows={3} value={text} placeholder="What should be on it? e.g. my face on the left, the plugin logo big on the right, two or three words of text"
            onChange={(e) => { typed.current = true; setText(e.target.value); }}
            onBlur={() => void saveText().catch(fail)}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </div>
      </div>
      <button className="primary tb-go" onClick={() => void make()} disabled={editor.chat.running || busy > 0}>
        {editor.chat.running ? "Hermes is busy…" : "Make thumbnails"}
      </button>
      <span className="dim small">Hermes uses your thumbnail template from the Library, the title, these instructions and photos, and adds 3 options below.</span>
    </div>
  );
}
