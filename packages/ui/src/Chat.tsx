import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { baseName } from "./time";
import type { Editor } from "./useEditor";

const IDEAS = ["Do a rough cut", "Cut the silences over one second", "Add a lower third with my name at the start", "Turn on captions"];

/** A conversation with the user's Hermes agent about this project. Edits it makes show up in the editor as they land. */
export function Chat({ editor }: { editor: Editor }) {
  const { chat, pid } = editor;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  /** Pictures waiting to go with the next message. */
  const [pics, setPics] = useState<{ file: string; url: string }[]>([]);
  const [uploading, setUploading] = useState(0);
  const [dropping, setDropping] = useState(false);
  const [profiles, setProfiles] = useState<{ profiles: string[]; current: string } | null>(null);
  useEffect(() => void api.hermesProfiles().then(setProfiles).catch(() => undefined), []);

  const addPictures = async (files: File[]) => {
    const images = files.filter((f) => /^image\/(png|jpeg|webp|gif)$/.test(f.type));
    if (files.length && !images.length) editor.notify("Only PNG, JPEG, WebP or GIF pictures can go in the chat.", "error");
    for (const f of images.slice(0, 8 - pics.length)) {
      setUploading((n) => n + 1);
      try {
        const r = await api.uploadChatImage(pid, f);
        setPics((p) => [...p, { file: r.file, url: api.chatImageUrl(pid, r.file) }].slice(0, 8));
      } catch (e) {
        editor.notify(e instanceof Error ? e.message : String(e), "error");
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };
  const end = useRef<HTMLDivElement>(null);
  const last = chat.messages[chat.messages.length - 1];
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [chat.messages.length, last?.text.length, chat.running]);

  const send = async (message: string) => {
    const body = message.trim();
    const attached = pics;
    if ((!body && !attached.length) || chat.running || sending || uploading) return;
    setSending(true);
    setText("");
    setPics([]);
    try {
      // Tell Hermes what the user is looking at, so "this clip" and "here" mean something.
      const { project, selectedClipId, selectedZoomId, selectedOverlayId } = editor;
      const clip = selectedClipId ? project.items[selectedClipId] : null;
      const selected =
        clip?.type === "clip" ? `clip ${clip.id} (${baseName(project.media.find((m) => m.id === clip.mediaId)?.path ?? clip.mediaId)})`
        : selectedZoomId ? `zoom ${selectedZoomId}`
        : selectedOverlayId ? `overlay ${selectedOverlayId}`
        : editor.range ? `range ${(Math.min(...editor.range) / 1e6).toFixed(2)}s to ${(Math.max(...editor.range) / 1e6).toFixed(2)}s`
        : undefined;
      await api.chatSend(pid, { text: body, playheadUs: Math.round(editor.player.tlUs), selected, ...(attached.length ? { images: attached.map((p) => p.file) } : {}) });
    } catch (e) {
      setText(body);
      setPics(attached);
      editor.notify(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="chat" aria-label="Chat with Hermes">
      <div className="chat-log" role="log" aria-live="polite">
        {chat.messages.length === 0 && (
          <div className="chat-empty">
            <p>Ask Hermes to edit this project. It works on the open timeline, and you can undo anything it does.</p>
            {IDEAS.map((idea) => (
              <button key={idea} className="chip" onClick={() => void send(idea)}>{idea}</button>
            ))}
          </div>
        )}
        {chat.messages.map((m) => (
          <div key={`${m.id}-${m.role}`} className={"msg " + m.role}>
            <span className="who">{m.role === "user" ? "You" : m.role === "assistant" ? "Hermes" : "Problem"}</span>
            {m.images && m.images.length > 0 && (
              <div className="msg-pics">
                {m.images.map((f) => (
                  <a key={f} href={api.chatImageUrl(pid, f)} target="_blank" rel="noreferrer"><img src={api.chatImageUrl(pid, f)} alt="Pasted picture" /></a>
                ))}
              </div>
            )}
            {m.text && m.text !== "(see the picture)" && <div className="body">{m.text}</div>}
          </div>
        ))}
        {chat.running && <div className="msg working"><span className="dot" /> {chat.activity || "Working"}…</div>}
        <div ref={end} />
      </div>
      <form
        className={"chat-form" + (dropping ? " dropping" : "")}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.stopPropagation();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          e.stopPropagation();
          setDropping(false);
          void addPictures(Array.from(e.dataTransfer.files));
        }}
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        {(pics.length > 0 || uploading > 0) && (
          <div className="chat-pics">
            {pics.map((p) => (
              <span key={p.file} className="chat-pic">
                <img src={p.url} alt="Picture to send" />
                <button type="button" title="Remove" onClick={() => setPics((all) => all.filter((x) => x.file !== p.file))}>×</button>
              </span>
            ))}
            {uploading > 0 && <span className="chat-pic loading">Adding…</span>}
          </div>
        )}
        <textarea
          value={text} rows={2} placeholder="Tell Hermes what to change… (paste or drop pictures here)" aria-label="Message to Hermes"
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
            if (!files.length) return;
            e.preventDefault();
            void addPictures(files);
          }}
          onKeyDown={(e) => {
            // Keys typed here must not trigger the editor's shortcuts.
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(text);
            }
          }}
        />
        <div className="row">
          {chat.running ? (
            <button type="button" onClick={() => void api.chatStop(pid)}>Stop</button>
          ) : (
            <button type="submit" className="primary" disabled={(!text.trim() && !pics.length) || sending || uploading > 0}>Send</button>
          )}
          {profiles && profiles.profiles.length > 1 && (
            <label className="chat-profile" title="Which Hermes profile the editor talks to, for chat and the rough cut. Applies to every project.">
              <span className="dim small">Profile</span>
              <select
                value={profiles.current} disabled={chat.running}
                onChange={(e) => {
                  const name = e.target.value;
                  void api.setHermesProfile(name).then(() => setProfiles({ ...profiles, current: name })).catch((err) => editor.notify(err instanceof Error ? err.message : String(err), "error"));
                }}
              >
                {profiles.profiles.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          )}
          <button type="button" className="ghost" disabled={chat.running || chat.messages.length === 0} onClick={() => void api.chatClear(pid)} title="Forget this conversation and start a new one">New chat</button>
        </div>
      </form>
    </div>
  );
}
