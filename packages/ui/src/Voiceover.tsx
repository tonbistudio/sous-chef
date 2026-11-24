import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import type { Op } from "@sous-chef/core";
import { api } from "./api";
import { local } from "./storage";
import { clock } from "./time";
import type { Editor } from "./useEditor";

type Phase = { kind: "idle" } | { kind: "countdown"; n: number } | { kind: "recording"; startUs: number; since: number } | { kind: "saving" };

/**
 * Records narration from the microphone at the playhead while the edit plays
 * silently, then puts it on a Voiceover track and transcribes it. Meant for
 * replacing the sound of a muted clip.
 */
export function VoiceoverButton({ editor: current }: { editor: Editor }) {
  const latest = useRef(current);
  latest.current = current;
  const editor = current;
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [, tick] = useState(0);
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[] } | null>(null);
  const timer = useRef(0);
  /** Kept outside state: the stop handler may be an older copy that cannot see new state. */
  const startAt = useRef(0);

  useEffect(() => () => {
    clearInterval(timer.current);
    rec.current?.stream.getTracks().forEach((t) => t.stop());
  }, []);

  const [open, setOpen] = useState(false);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [mic, setMic] = useState(() => local.get("sous.mic") ?? "");
  const [clean, setClean] = useState(() => local.get("sous.voClean") !== "0");
  const toggle = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    try {
      // Microphone names are hidden until the page has been allowed to use one.
      let list = await navigator.mediaDevices.enumerateDevices();
      if (list.some((d) => d.kind === "audioinput" && !d.label)) {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());
        list = await navigator.mediaDevices.enumerateDevices();
      }
      setMics(list.filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications"));
    } catch {
      setMics([]);
    }
  };

  const start = async () => {
    setOpen(false);
    let stream: MediaStream;
    try {
      const mic = local.get("sous.mic");
      // The browser's own processing is off: the clean-up happens once, on the saved file.
      const audio: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1, sampleRate: 48000 };
      stream = await navigator.mediaDevices.getUserMedia({ audio: mic ? { ...audio, deviceId: { exact: mic } } : audio }).catch((e) => {
        // The chosen microphone was unplugged: fall back to the default one.
        if (!mic) throw e;
        return navigator.mediaDevices.getUserMedia({ audio });
      });
    } catch (e) {
      editor.notify(`No microphone: ${e instanceof Error ? e.message : String(e)}`, "error");
      return;
    }
    const type = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg"].find((t) => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 256_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.current = { recorder, stream, chunks };
    editor.player.pause();
    // A short count-in so the first word is not clipped.
    for (let n = 3; n > 0; n--) {
      setPhase({ kind: "countdown", n });
      await new Promise((r) => setTimeout(r, 700));
    }
    const startUs = Math.round(editor.player.tlUs);
    startAt.current = startUs;
    editor.player.setSilent(true);
    recorder.start(1000);
    editor.player.play();
    setPhase({ kind: "recording", startUs, since: performance.now() });
    timer.current = window.setInterval(() => {
      tick((x) => x + 1);
      if (!editor.player.playing) void stop();
    }, 250);
  };

  const stop = async () => {
    const editor = latest.current;
    clearInterval(timer.current);
    const r = rec.current;
    rec.current = null;
    editor.player.pause();
    editor.player.setSilent(false);
    if (!r) return;
    const startUs = startAt.current;
    setPhase({ kind: "saving" });
    await new Promise<void>((resolve) => {
      r.recorder.onstop = () => resolve();
      if (r.recorder.state !== "inactive") r.recorder.stop();
      else resolve();
    });
    r.stream.getTracks().forEach((t) => t.stop());
    try {
      const blob = new Blob(r.chunks, { type: r.recorder.mimeType || "audio/webm" });
      const { path } = await api.uploadRecording(editor.pid, blob, local.get("sous.voClean") !== "0");
      const created = await editor.run(`Record voiceover at ${clock(startUs)}`, [{ op: "media.add", media: { path } as never }]);
      const mediaId = created?.[created.length - 1];
      if (!mediaId) return;
      // It goes on the first audio lane with room for it, so lanes only multiply where takes overlap.
      // Recorded against the picture, it starts locked to the footage under it (unlock it in Details).
      const underPicture = editor.plan.segments.some((s) => s.trackKind === "main" && s.hasVideo && startUs >= s.tlStartUs && startUs < s.tlEndUs);
      const clipId = `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
      const lock: Op[] = underPicture ? [{ op: "clip.set", clipId, linked: true }] : [];
      const lanes = editor.project.tracks.filter((t) => t.kind === "audio" && !t.locked);
      let added: unknown = null;
      for (const t of lanes) {
        added = await editor.run("Place voiceover", [{ op: "clip.add", trackId: t.id, mediaId, startUs, id: clipId }, ...lock], { quiet: true });
        if (added) break;
      }
      if (!added) {
        const lane = `vo${Date.now().toString(36).slice(-5)}`;
        added = await editor.run("Place voiceover", [{ op: "track.add", kind: "audio", id: lane, name: lanes.length ? `Voiceover ${lanes.length + 1}` : "Voiceover" }, { op: "clip.add", trackId: lane, mediaId, startUs, id: clipId }, ...lock]);
      }
      editor.notify("Voiceover added. Transcribing it.");
      await api.transcribe(editor.pid, [mediaId]).catch(() => undefined);
    } catch (e) {
      editor.notify(`Could not save the recording: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setPhase({ kind: "idle" });
    }
  };

  if (phase.kind === "countdown") return <button className="rec on" disabled>Recording in {phase.n}…</button>;
  if (phase.kind === "recording") {
    const secs = (performance.now() - phase.since) / 1000;
    return (
      <button className="rec on" onClick={() => void stop()} title="Stop recording (the edit plays silently while you speak)">
        ■ Stop · {clock(secs * 1e6, 0)}
      </button>
    );
  }
  if (phase.kind === "saving") return <button className="rec" disabled>Saving…</button>;
  return (
    <span className="rec-group">
      <button className="rec with-icon" onClick={() => void start()} disabled={editor.plan.durationUs === 0} title="Record narration from the microphone, starting at the playhead. The edit plays silently while you speak.">
        <Icon name="mic" />Voiceover
      </button>
      <button className="rec-more" aria-label="Voiceover settings" aria-expanded={open} onClick={() => void toggle()} title="Choose the microphone and the sound clean-up"><Icon name="chevron" size={14} /></button>
      {open && (
        <div className="rec-menu" role="dialog" aria-label="Voiceover settings">
          <label>
            Microphone
            <select value={mic} onChange={(e) => { setMic(e.target.value); local.set("sous.mic", e.target.value); }}>
              <option value="">System default</option>
              {mics.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={clean} onChange={(e) => { setClean(e.target.checked); local.set("sous.voClean", e.target.checked ? "1" : "0"); }} />
            Clean up the sound
          </label>
          <p className="dim">Noise reduction, a compressor, light EQ and an expander, applied when the recording is saved. The untouched recording is kept in the project's recordings/originals folder.</p>
        </div>
      )}
    </span>
  );
}
