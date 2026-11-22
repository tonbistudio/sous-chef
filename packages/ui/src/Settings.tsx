import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Icon } from "./icons";
import { local } from "./storage";
import type { Editor } from "./useEditor";

/** Whether Hermes reads its chat replies aloud. Shared by the settings popup and the chat. */
const SPEAK_KEY = "sous.speak";
const SPEAK_EVENT = "sous:speak";
export const speakReplies = (): boolean => local.get(SPEAK_KEY) === "1";
export function setSpeakReplies(on: boolean): void {
  local.set(SPEAK_KEY, on ? "1" : "0");
  window.dispatchEvent(new CustomEvent(SPEAK_EVENT, { detail: on }));
}
export function onSpeakReplies(fn: (on: boolean) => void): () => void {
  const h = (e: Event) => fn(Boolean((e as CustomEvent<boolean>).detail));
  window.addEventListener(SPEAK_EVENT, h);
  return () => window.removeEventListener(SPEAK_EVENT, h);
}

type Prefs = Awaited<ReturnType<typeof api.preferences>>;

/** A gear in the top bar that opens the app's settings: Hermes, voice, and what new projects start with. */
export function SettingsButton({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className="settings-anchor" ref={box}>
      <button className={"ghost icon-only" + (open ? " on" : "")} onClick={() => setOpen((o) => !o)} title="Settings" aria-label="Settings" aria-expanded={open}>
        <Icon name="gear" />
      </button>
      {open && <SettingsPanel editor={editor} />}
    </div>
  );
}

function SettingsPanel({ editor }: { editor: Editor }) {
  const [profiles, setProfiles] = useState<{ profiles: string[]; current: string } | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [speak, setSpeak] = useState(speakReplies);
  const fail = (e: unknown) => editor.notify(e instanceof Error ? e.message : String(e), "error");
  useEffect(() => {
    void api.hermesProfiles().then(setProfiles).catch(() => undefined);
    void api.preferences().then(setPrefs).catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const save = (patch: Partial<Prefs>) => void api.setPreferences(patch).then(setPrefs).catch(fail);

  return (
    <div className="settings-pop" role="dialog" aria-label="Settings">
      <h3>Hermes</h3>
      <label className="set-row" title="Which Hermes profile the editor talks to, for chat, voice and the rough cut. Applies to every project.">
        <span>Profile</span>
        <select
          value={profiles?.current ?? ""} disabled={!profiles}
          onChange={(e) => {
            const name = e.target.value;
            void api.setHermesProfile(name).then(() => setProfiles((p) => (p ? { ...p, current: name } : p))).catch(fail);
          }}
        >
          {profiles?.profiles.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </label>
      <label className="set-row check" title="Uses the profile's own voice. Hold V anywhere to talk to Hermes.">
        <input
          type="checkbox" checked={speak}
          onChange={(e) => {
            setSpeak(e.target.checked);
            setSpeakReplies(e.target.checked);
          }}
        />
        <span>Read Hermes's replies aloud</span>
      </label>

      <h3>New projects</h3>
      <label className="set-row">
        <span>Projects folder</span>
        <input
          key={prefs?.projectsFolder} defaultValue={prefs?.projectsFolder ?? ""} spellCheck={false} disabled={!prefs}
          onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== prefs?.projectsFolder && save({ projectsFolder: e.target.value.trim() })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </label>
      <label className="set-row">
        <span>Start at speed</span>
        <select value={String(prefs?.newProjectSpeed ?? 1)} disabled={!prefs} onChange={(e) => save({ newProjectSpeed: Number(e.target.value) })}>
          {[1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.5].concat(prefs && ![1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.5].includes(prefs.newProjectSpeed) ? [prefs.newProjectSpeed] : []).map((s) => (
            <option key={s} value={String(s)}>{s}×</option>
          ))}
        </select>
      </label>
      <label className="set-row">
        <span>Level loudness to</span>
        <select value={prefs?.newProjectLufs == null ? "off" : String(prefs.newProjectLufs)} disabled={!prefs} onChange={(e) => save({ newProjectLufs: e.target.value === "off" ? null : Number(e.target.value) })}>
          <option value="off">Off</option>
          {[-14, -16, -18].concat(prefs?.newProjectLufs != null && ![-14, -16, -18].includes(prefs.newProjectLufs) ? [prefs.newProjectLufs] : []).map((l) => (
            <option key={l} value={String(l)}>{l} LUFS{l === -14 ? " (YouTube)" : ""}</option>
          ))}
        </select>
      </label>
      <p className="set-note">Hold <kbd>V</kbd> to talk to Hermes · <kbd>D</kbd> to draw on the frame</p>
    </div>
  );
}
