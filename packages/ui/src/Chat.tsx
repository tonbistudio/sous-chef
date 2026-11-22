import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { takeAttachments } from "./attach";
import { Icon } from "./icons";
import { onSpeakReplies, speakReplies } from "./Settings";
import { baseName } from "./time";
import type { Editor } from "./useEditor";

const MAX_TALK_MS = 120_000;

const IDEAS = ["Do a rough cut", "Cut the silences over one second", "Add a lower third with my name at the start", "Turn on captions"];

/** A conversation with the user's Hermes agent about this project. Edits it makes show up in the editor as they land. */
export function Chat({ editor }: { editor: Editor }) {
  const { chat, pid } = editor;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  /** Pictures waiting to go with the next message; a marked-up frame carries its marks in words. */
  const [pics, setPics] = useState<{ file: string; url: string; note?: string }[]>([]);
  useEffect(() => takeAttachments((a) => setPics((p) => [...p, a].slice(-8))), []);
  const [uploading, setUploading] = useState(0);
  const [dropping, setDropping] = useState(false);

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

  // ---- Talking to Hermes, with the chosen profile's own speech-to-text and voice ----
  const [talk, setTalk] = useState<"idle" | "recording" | "transcribing">("idle");
  // Set in the settings popup (the gear in the top bar).
  const [speakOn, setSpeakOn] = useState(speakReplies);
  useEffect(() => onSpeakReplies((on) => {
    setSpeakOn(on);
    if (!on) stopSpeaking();
  }), []);
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; sendAfter: boolean; timer: number } | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const sendRef = useRef<(m: string) => Promise<void>>(async () => {});

  const stopSpeaking = () => {
    audio.current?.pause();
    if (audio.current) URL.revokeObjectURL(audio.current.src);
    audio.current = null;
  };

  const startTalking = useCallback(async (sendAfter: boolean) => {
    if (rec.current) return;
    stopSpeaking();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const type = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType: type });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const timer = window.setTimeout(() => stopTalking(), MAX_TALK_MS);
      rec.current = { recorder, stream, chunks, sendAfter, timer };
      recorder.start(250);
      setTalk("recording");
    } catch (e) {
      editor.notify(e instanceof Error && e.name === "NotAllowedError" ? "Sous Chef isn't allowed to use the microphone." : `Could not start the microphone: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  const stopTalking = useCallback(() => {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    window.clearTimeout(r.timer);
    r.recorder.onstop = async () => {
      r.stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(r.chunks, { type: "audio/webm" });
      if (blob.size < 1500) {
        setTalk("idle");
        return;
      }
      setTalk("transcribing");
      try {
        const said = (await api.hearSpeech(blob)).trim();
        if (!said) editor.notify("Hermes didn't catch any words.", "info");
        else if (r.sendAfter) await sendRef.current([textRef.current.trim(), said].filter(Boolean).join(" "));
        else setText((t) => (t.trim() ? `${t.trim()} ${said}` : said));
      } catch (e) {
        editor.notify(e instanceof Error ? e.message : String(e), "error");
      } finally {
        setTalk("idle");
      }
    };
    r.recorder.stop();
  }, [editor]);

  // Hold V anywhere in the editor (outside a text box) to talk; letting go sends it.
  useEffect(() => {
    const editable = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "v" || e.repeat || e.ctrlKey || e.metaKey || e.altKey || editable(e.target)) return;
      e.preventDefault();
      void startTalking(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "v" || !rec.current?.sendAfter) return;
      e.preventDefault();
      stopTalking();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [startTalking, stopTalking]);
  useEffect(() => () => {
    const r = rec.current;
    if (r) {
      window.clearTimeout(r.timer);
      r.recorder.onstop = null;
      r.recorder.stop();
      r.stream.getTracks().forEach((t) => t.stop());
    }
    stopSpeaking();
  }, []);

  // Read Hermes's reply aloud when it finishes, if the speaker is on.
  const wasRunning = useRef(chat.running);
  useEffect(() => {
    const finished = wasRunning.current && !chat.running;
    wasRunning.current = chat.running;
    const reply = chat.messages[chat.messages.length - 1];
    if (!finished || !speakOn || reply?.role !== "assistant" || !reply.text.trim()) return;
    let gone = false;
    void api.speak(reply.text).then((blob) => {
      if (gone) return;
      stopSpeaking();
      const a = new Audio(URL.createObjectURL(blob));
      audio.current = a;
      a.onended = () => stopSpeaking();
      void a.play();
    }).catch((e: unknown) => editor.notify(e instanceof Error ? e.message : String(e), "error"));
    return () => void (gone = true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.running]);

  const send = async (message: string) => {
    const body = message.trim();
    const attached = pics;
    stopSpeaking();
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
      const marks = attached.map((p) => p.note).filter(Boolean).join(" | ");
      await api.chatSend(pid, { text: body, playheadUs: Math.round(editor.player.tlUs), selected, ...(attached.length ? { images: attached.map((p) => p.file) } : {}), ...(marks ? { marks } : {}) });
    } catch (e) {
      setText(body);
      setPics(attached);
      editor.notify(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setSending(false);
    }
  };
  sendRef.current = send;

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
              <span key={p.file} className={"chat-pic" + (p.note ? " marked" : "")} title={p.note ? "Your drawing on the frame; Hermes gets the positions too" : undefined}>
                <img src={p.url} alt={p.note ? "Marked-up frame to send" : "Picture to send"} />
                <button type="button" title="Remove" onClick={() => setPics((all) => all.filter((x) => x.file !== p.file))}>×</button>
              </span>
            ))}
            {uploading > 0 && <span className="chat-pic loading">Adding…</span>}
          </div>
        )}
        <textarea
          value={text} rows={2} placeholder={talk === "recording" ? "Listening… (let go of V, or press the mic to stop)" : talk === "transcribing" ? "Turning your words into text…" : "Tell Hermes what to change… Hold V to talk, D to draw on the frame"} aria-label="Message to Hermes"
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
          <button
            type="button" className={"talk-btn" + (talk === "recording" ? " on" : "")} disabled={talk === "transcribing"}
            onClick={() => (talk === "recording" ? stopTalking() : void startTalking(false))}
            title={talk === "recording" ? "Stop and put the words in the box" : "Talk to Hermes: press, speak, press again to review before sending. Or hold V to talk and send at once."}
            aria-label={talk === "recording" ? "Stop talking" : "Talk"}
          >
            {talk === "transcribing" ? <span className="dot" /> : <Icon name="mic" />}
          </button>
          {chat.running ? (
            <button type="button" onClick={() => void api.chatStop(pid)}>Stop</button>
          ) : (
            <button type="submit" className="primary" disabled={(!text.trim() && !pics.length) || sending || uploading > 0}>Send</button>
          )}
          <button type="button" className="ghost" disabled={chat.running || chat.messages.length === 0} onClick={() => void api.chatClear(pid)} title="Forget this conversation and start a new one">New chat</button>
        </div>
      </form>
    </div>
  );
}
