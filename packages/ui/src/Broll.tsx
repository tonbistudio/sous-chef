import type { Media, Op } from "@sous-chef/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, subscribe, type BrollEngine, type BrollItem, type BrollKind, type BrollSettings } from "./api";
import { placeMedia } from "./dragMedia";
import { Icon } from "./icons";
import { clock } from "./time";
import type { Editor } from "./useEditor";

const samePath = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

/**
 * The Library's B-roll section: two makers side by side (Imagination Studio on your machine, Hermes's
 * tools in the cloud), each with just Image or Video and a prompt at default settings, and a shelf of
 * what they made to drop into the open timeline. Anything finer is for Hermes in the chat.
 */
export function Broll({ editor }: { editor: Editor }) {
  const [items, setItems] = useState<BrollItem[] | null>(null);
  const [settings, setSettings] = useState<BrollSettings | null>(null);
  const notify = useRef(editor.notify);
  notify.current = editor.notify;
  const load = useCallback(() => {
    void api.broll().then((r) => { setItems(r.items); setSettings(r.settings); }).catch((e) => notify.current(e instanceof Error ? e.message : String(e), "error"));
  }, []);
  useEffect(() => load(), [load]);
  useEffect(() => subscribe((e) => e.type === "broll" && load(), () => {}), [load]);
  const fail = (e: unknown) => editor.notify(e instanceof Error ? e.message : String(e), "error");

  const make = async (engine: BrollEngine, kind: BrollKind, prompt: string): Promise<boolean> => {
    try {
      await api.makeBroll(engine, kind, prompt);
      load();
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };

  const insert = async (item: BrollItem) => {
    if (!item.path) return;
    const at = Math.round(editor.player.tlUs);
    const have = editor.project.media.find((m) => samePath(m.path, item.path!));
    const pre: Op[] = [];
    let media: Media;
    if (have) media = have;
    else {
      const id = `m${Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
      pre.push({ op: "media.add", media: { id, path: item.path } as never });
      media = { id, path: item.path, kind: item.kind === "image" ? "image" : "video", durationUs: item.durationUs ?? 5_000_000 } as Media;
    }
    try {
      await placeMedia(editor, media, at, undefined, "video", pre);
      editor.notify(`B-roll added at ${clock(at)}`);
    } catch (e) {
      fail(e);
    }
  };

  return (
    <>
      <div className="broll-makers">
        <Maker
          engine="local" title="On your machine" sub="Imagination Studio · free, takes a few minutes"
          onMake={make} foot={<StudioSettings settings={settings} onSaved={setSettings} fail={fail} />}
        />
        <Maker
          engine="cloud" title="In the cloud" sub="Hermes's image and video tools · uses your provider's credits"
          onMake={make} foot={<span className="broll-foot-note">Uses the providers set up in the Hermes profile Sous Chef talks to.</span>}
        />
      </div>
      <p className="ref-hint">Default settings only. For another size, length, model or a starting picture, ask Hermes in the chat; it can use Imagination Studio for you.</p>
      {items && items.length === 0 && <p className="lib-empty">Nothing made yet. Describe a shot above and press Make.</p>}
      <ul className="ref-grid broll-grid">
        {items?.map((it) => <Card key={it.id} item={it} editor={editor} onInsert={insert} onAgain={() => void make(it.engine, it.kind, it.prompt)} fail={fail} />)}
      </ul>
    </>
  );
}

function Maker({ engine, title, sub, onMake, foot }: { engine: BrollEngine; title: string; sub: string; onMake: (e: BrollEngine, k: BrollKind, p: string) => Promise<boolean>; foot: React.ReactNode }) {
  const [kind, setKind] = useState<BrollKind>("image");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    if (await onMake(engine, kind, prompt.trim())) setPrompt("");
    setBusy(false);
  };
  return (
    <section className={`broll-maker ${engine}`} aria-label={title}>
      <header>
        <strong>{title}</strong>
        <span>{sub}</span>
      </header>
      <div className="broll-kind" role="radiogroup" aria-label="What to make">
        {(["image", "video"] as const).map((k) => (
          <button key={k} role="radio" aria-checked={kind === k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
            <Icon name={k === "image" ? "image" : "film"} /> {k === "image" ? "Image" : "Video"}
          </button>
        ))}
      </div>
      <textarea
        rows={3} value={prompt} spellCheck
        placeholder={kind === "image" ? "A picture: subject, place, light, style…" : "A short clip: what happens and how the camera moves…"}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void go();
        }}
      />
      <div className="broll-go">
        <button className="primary" disabled={!prompt.trim() || busy} onClick={() => void go()}>{kind === "image" ? "Make image" : "Make video"}</button>
        <span>{kind === "image" ? "One picture, 16:9" : engine === "local" ? "5 seconds, 720p" : "The provider's default length"}</span>
      </div>
      <div className="broll-foot">{foot}</div>
    </section>
  );
}

function StudioSettings({ settings, onSaved, fail }: { settings: BrollSettings | null; onSaved: (s: BrollSettings) => void; fail: (e: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (settings) setUrl(settings.studioUrl);
  }, [settings]);
  if (!settings) return null;
  const save = async () => {
    setBusy(true);
    setCheck(null);
    try {
      const s = await api.saveBrollSettings({ studioUrl: url, ...(key.trim() ? { key: key.trim() } : {}) });
      onSaved(s);
      setKey("");
      setCheck(await api.checkStudio());
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  if (!open)
    return (
      <button className="link" onClick={() => { setOpen(true); setCheck(null); }} title="Where Imagination Studio runs">
        <Icon name="gear" size={13} /> {settings.studioUrl}{settings.hasKey ? " · key saved" : ""}
      </button>
    );
  return (
    <div className="broll-studio" onKeyDown={(e) => e.stopPropagation()}>
      <label>
        <span>Studio address</span>
        <input value={url} spellCheck={false} placeholder="http://127.0.0.1:7870" onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label>
        <span>Access key</span>
        <input type="password" value={key} autoComplete="off" placeholder={settings.hasKey ? "Saved (type to replace)" : "From the Studio's Settings page"} onChange={(e) => setKey(e.target.value)} />
      </label>
      {check && <p className={check.ok ? "ok" : "bad"}>{check.message}</p>}
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => void save()}>{busy ? "Checking…" : "Save and check"}</button>
        <button className="ghost" onClick={() => setOpen(false)}>Done</button>
      </div>
    </div>
  );
}

function Card({ item, editor, onInsert, onAgain, fail }: { item: BrollItem; editor: Editor; onInsert: (i: BrollItem) => void; onAgain: () => void; fail: (e: unknown) => void }) {
  const [asking, setAsking] = useState(false);
  const tall = item.width && item.height && item.height > item.width;
  return (
    <li className={`broll-card ${item.status}`}>
      <div className={"ref-thumb" + (tall ? " tall" : "")}>
        {item.status === "done" && <img src={api.brollThumbUrl(item.id)} alt="" loading="lazy" />}
        {item.status === "working" && (
          <div className="broll-wait">
            <span className="broll-spin" aria-hidden="true" />
            <span>{item.progress !== undefined ? `Making… ${Math.round(item.progress * 100)}%` : "Making…"}</span>
          </div>
        )}
        {item.status === "failed" && <span className="broll-err" title={item.error}>{item.error ?? "Didn't work"}</span>}
        <em>{item.kind === "video" ? (item.durationUs ? clock(item.durationUs, 1) : "Video") : "Image"}</em>
        <b className={`broll-where ${item.engine}`}>{item.engine === "local" ? "Local" : "Cloud"}</b>
      </div>
      <div className="ref-body">
        <p className="broll-prompt" title={item.prompt}>{item.prompt}</p>
        <div className="ref-actions">
          {item.status === "done" && <button onClick={() => onInsert(item)} title="Put it on a video lane over the open timeline, at the playhead">Insert at {clock(editor.player.tlUs)}</button>}
          {item.status === "working" && <button className="ghost" onClick={() => void api.cancelBroll(item.id).catch(fail)}>Stop</button>}
          {item.status === "failed" && <button onClick={onAgain}>Try again</button>}
          <span className="broll-act-right">
            {item.status === "done" && <button className="ghost" onClick={onAgain} title="Make another with the same prompt">Again</button>}
            {item.status !== "working" && (
              <button
                className="ghost" onBlur={() => setAsking(false)}
                title="Delete it from the library. Projects already using it will show it as missing."
                onClick={() => {
                  if (!asking) return setAsking(true);
                  setAsking(false);
                  void api.removeBroll(item.id).catch(fail);
                }}
              >
                {asking ? "Delete?" : <Icon name="trash" />}
              </button>
            )}
          </span>
        </div>
      </div>
    </li>
  );
}
