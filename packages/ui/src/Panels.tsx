import { layerBoxes, TRANSITION_KINDS, type Clip, type Media, type Op, type Overlay, type TransitionKind, type Zoom } from "@sous-chef/core";
import { TRANSITION_NAMES, transitionCuts } from "./transitions";
import { live } from "./live";
import { cueAt } from "./timeIndex";
import { Icon } from "./icons";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import { desktop } from "./desktop";
import { FilePicker } from "./FilePicker";
import { VoiceoverButton } from "./Voiceover";
import { baseName, clock, S } from "./time";
import type { Editor } from "./useEditor";
import { placeMedia, setDraggedMedia } from "./dragMedia";

/**
 * Adds a file to a video or audio track at the playhead: the first track of
 * that kind with room, or a new one.
 */
async function addAtPlayhead(editor: Editor, m: Media, kind: "video" | "audio"): Promise<void> {
  await placeMedia(editor, m, editor.player.tlUs, undefined, kind);
}

export function MediaBin({ editor }: { editor: Editor }) {
  const [picking, setPicking] = useState(false);
  const { project, pid } = editor;

  const importFiles = async (paths: string[]) => {
    setPicking(false);
    // One transaction per file, so one bad file does not block the rest.
    let added = 0;
    for (const path of paths) {
      const created = await editor.run(`Import ${baseName(path)}`, [{ op: "media.add", media: { path } as never }]);
      if (created) added++;
    }
    if (added) editor.notify(`Imported ${added} file${added === 1 ? "" : "s"}`);
  };

  const [dropping, setDropping] = useState(false);
  const [missing, setMissing] = useState<{ mediaId: string; path: string }[]>([]);
  const mediaKey = project.media.map((m) => m.id + m.path).join("|");
  useEffect(() => {
    void api.missing(pid).then((r) => setMissing(r.missing)).catch(() => undefined);
  }, [pid, mediaKey]);
  const relink = async (mediaId: string) => {
    const paths = desktop ? await desktop.pickMedia() : [];
    if (!desktop) {
      editor.notify("Use Import in the desktop app to find the moved file, or ask Hermes to relink it.", "error");
      return;
    }
    if (paths[0]) await editor.run("Find moved file", [{ op: "media.relink", mediaId, media: { path: paths[0] } }]);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    const paths = desktop?.pathForFile ? files.map((f) => desktop!.pathForFile!(f)).filter(Boolean) : [];
    if (!paths.length) {
      editor.notify("Dropping files works in the desktop app. Here, use Import.", "error");
      return;
    }
    void importFiles(paths);
  };

  return (
    <aside
      className={"bin" + (dropping ? " dropping" : "")} aria-label="Media"
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDropping(true); } }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      <header>
        <h2>Media</h2>
        <button
          onClick={() => {
            if (desktop) {
              void desktop.pickMedia().then((paths) => {
                if (paths.length) void importFiles(paths);
              });
            } else setPicking(true);
          }}
        >
          Import
        </button>
      </header>
      {missing.length > 0 && (
        <div className="missing" role="alert">
          <strong>{missing.length} file{missing.length === 1 ? " is" : "s are"} missing</strong>
          {missing.map((m) => (
            <div key={m.mediaId} className="row">
              <span className="dim" title={m.path}>{baseName(m.path)}</span>
              <button onClick={() => void relink(m.mediaId)}>Find…</button>
            </div>
          ))}
        </div>
      )}
      <ul>
        {project.media.map((m) => {
          const uses = Object.values(project.items).filter((c) => c.type === "clip" && c.mediaId === m.id).length;
          return (
            <li
              key={m.id} className="media" draggable
              title="Drag onto the timeline to place it there"
              onDragStart={(e) => {
                setDraggedMedia(m);
                e.dataTransfer.effectAllowed = "copy";
                e.dataTransfer.setData("text/plain", baseName(m.path));
              }}
              onDragEnd={() => setDraggedMedia(null)}
            >
              {missing.some((x) => x.mediaId === m.id) ? (
                <div className="thumb-audio thumb-missing">File missing</div>
              ) : m.probe.hasVideo ? (
                <img draggable={false} src={api.frameUrl(pid, m.id, Math.min(m.durationUs * 0.1, 5_000_000), 240)} alt="" loading="lazy" onError={(e) => e.currentTarget.classList.add("broken")} />
              ) : (
                <div className="thumb-audio">Audio</div>
              )}
              <div className="media-info">
                <span className="media-name" title={m.path}>{baseName(m.path)}</span>
                <span className="media-meta">
                  {clock(m.durationUs, 0)}
                  {m.probe.width ? ` · ${m.probe.width}×${m.probe.height}` : ""}
                  {m.probe.fps ? ` · ${Math.round(m.probe.fps)} fps` : ""}
                </span>
                <span className="media-actions">
                  {m.kind === "video" && (
                    <button onClick={() => void editor.run(`Add ${baseName(m.path)} to the timeline`, [{ op: "clip.add", trackId: "main", mediaId: m.id }])}>
                      Add to timeline
                    </button>
                  )}
                  {m.kind !== "audio" && (
                    <button title="Put it over the main video at the playhead, on its own track" onClick={() => void addAtPlayhead(editor, m, "video")}>
                      {m.kind === "image" ? "Add at playhead" : "Overlay"}
                    </button>
                  )}
                  {m.probe.hasAudio && (
                    <button title="Put its sound on an audio track at the playhead, under the main sound" onClick={() => void addAtPlayhead(editor, m, "audio")}>
                      {m.kind === "audio" ? "Add as music" : "Sound only"}
                    </button>
                  )}
                  {uses === 0 && (
                    <button className="ghost" onClick={() => void editor.run(`Remove ${baseName(m.path)}`, [{ op: "media.remove", mediaId: m.id }])}>
                      Remove
                    </button>
                  )}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      {project.media.length === 0 && <p className="empty">No media yet. Import your raw takes to begin. The files are used in place and never changed.</p>}
      {picking && <FilePicker mode="files" title="Import media" onCancel={() => setPicking(false)} onFiles={importFiles} />}
    </aside>
  );
}

function TimeReadout({ editor }: { editor: Editor }) {
  const tl = useSyncExternalStore(editor.player.subscribe, editor.player.getTime);
  return (
    <span className="time">
      {clock(tl, 2)} <span className="dim">/ {clock(editor.plan.durationUs, 2)}</span>
    </span>
  );
}

function PlayButton({ editor }: { editor: Editor }) {
  const playing = useSyncExternalStore(editor.player.subscribe, editor.player.getPlaying);
  return (
    <button className="primary play round" onClick={() => editor.player.toggle()} disabled={editor.plan.durationUs === 0} title={playing ? "Pause (Space)" : "Play (Space)"} aria-label={playing ? "Pause" : "Play"}>
      <Icon name={playing ? "pause" : "play"} size={20} />
    </button>
  );
}

export function Preview({ editor }: { editor: Editor }) {
  const host = useRef<HTMLDivElement>(null);
  const { player, plan } = editor;

  useEffect(() => {
    player.attach(host.current);
    return () => {
      player.pause();
      player.attach(null);
    };
  }, [player]);

  return (
    <section className="preview" aria-label="Preview">
      <div className="stage-wrap">
      <div className="stage" style={{ aspectRatio: `${plan.width} / ${plan.height}`, ["--ar" as never]: plan.width / plan.height }}>
        <div
          className="stage-host" ref={host}
          onClick={(e) => {
            // Clicking a picture or overlay video selects it; anywhere else plays or pauses.
            const r = e.currentTarget.getBoundingClientRect();
            const fx = (e.clientX - r.left) / r.width;
            const fy = (e.clientY - r.top) / r.height;
            const tl = player.tlUs;
            // Text and graphics sit above pictures, so they are found first.
            const stageBox = e.currentTarget.parentElement?.getBoundingClientRect();
            const overlayHit = [...plan.overlays].reverse().find((o) => {
              if (tl < o.tlStartUs || tl >= o.tlEndUs) return false;
              if (o.kind === "text") {
                const el = e.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-ov="${o.id}"]`);
                const r = el?.getBoundingClientRect();
                return Boolean(r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom);
              }
              // A full-screen graphic would catch every click, so only smaller ones are picked here.
              const t = o.transform;
              if (t.scale > 0.9 || !stageBox) return false;
              const x0 = 0.5 + t.x - t.scale / 2;
              const y0 = 0.5 + t.y - t.scale / 2;
              return fx >= x0 && fx <= x0 + t.scale && fy >= y0 && fy <= y0 + t.scale;
            });
            if (overlayHit) {
              if (overlayHit.id !== editor.selectedOverlayId) {
                player.pause();
                editor.selectClip(null);
                editor.selectZoom(null);
                editor.selectOverlay(overlayHit.id);
              } else player.toggle();
              return;
            }
            const hit = [...plan.segments].reverse().find((sg) => {
              if (sg.trackKind !== "video" || !sg.hasVideo || tl < sg.tlStartUs || tl >= sg.tlEndUs) return false;
              const [x, y, w, h] = layerBoxes(sg.transform, sg.aspect, plan.width / plan.height).visible;
              return fx >= x && fx <= x + w && fy >= y && fy <= y + h;
            });
            if (hit && hit.clipId !== editor.selectedClipId) {
              player.pause();
              editor.selectZoom(null);
              editor.selectOverlay(null);
              editor.selectClip(hit.clipId);
            } else if (!hit) player.toggle();
          }}
        />
        <StageLayers editor={editor} />
        {(() => {
          const z = editor.selectedZoomId ? editor.project.items[editor.selectedZoomId] : null;
          return z && z.type === "zoom" ? <ZoomBox editor={editor} zoom={z} /> : null;
        })()}
        {(() => {
          const o = editor.selectedOverlayId ? editor.project.items[editor.selectedOverlayId] : null;
          return o && o.type === "overlay" ? <OverlayBox key={o.id} editor={editor} overlay={o} /> : null;
        })()}
        {(() => {
          const c = editor.selectedClipId ? editor.project.items[editor.selectedClipId] : null;
          const track = c ? editor.project.tracks.find((t) => t.items.includes(c.id)) : null;
          return c && c.type === "clip" && (track?.kind === "video" || track?.kind === "main") ? <LayerBox key={c.id} editor={editor} clip={c} main={track.kind === "main"} /> : null;
        })()}
        {plan.durationUs === 0 && <div className="stage-empty">Nothing on the timeline yet</div>}
      </div>
      </div>
      <div className="transport">
        <TimeReadout editor={editor} />
        <span className="transport-buttons">
          <button className="round ghost" onClick={() => player.seek(Math.max(0, player.tlUs - 5 * S))} disabled={plan.durationUs === 0} title="Back 5 seconds (Shift+Left). Left arrow steps one frame." aria-label="Back 5 seconds"><Icon name="back5" size={20} /></button>
          <PlayButton editor={editor} />
          <button className="round ghost" onClick={() => player.seek(Math.min(plan.durationUs, player.tlUs + 5 * S))} disabled={plan.durationUs === 0} title="Forward 5 seconds (Shift+Right). Right arrow steps one frame." aria-label="Forward 5 seconds"><Icon name="fwd5" size={20} /></button>
        </span>
        <VoiceoverButton editor={editor} />
      </div>
    </section>
  );
}

/** Captions and text overlays drawn over the preview, the same way export burns them in. */
function StageLayers({ editor }: { editor: Editor }) {
  const { plan, cues, project, player } = editor;
  const cap = project.settings.captions;
  const textOverlays = useMemo(() => plan.overlays.filter((o) => o.kind === "text"), [plan]);
  // Redrawn only when what shows changes (a caption, a text coming or going, a fade step), not on
  // every one of the 60 playhead updates a second.
  const shown = useCallback(() => {
    const t = player.getTime();
    const c = cap?.enabled ? cueAt(cues, t) : undefined;
    let key = c ? `c${c.startUs}` : "-";
    for (const o of textOverlays) {
      if (t < o.tlStartUs || t >= o.tlEndUs) continue;
      const fading = (o.fadeInUs > 0 && t < o.tlStartUs + o.fadeInUs) || (o.fadeOutUs > 0 && t > o.tlEndUs - o.fadeOutUs);
      key += `|${o.id}${fading ? `@${Math.round(t / 16_667)}` : ""}`;
    }
    return key;
  }, [player, cues, cap?.enabled, textOverlays]);
  useSyncExternalStore(player.subscribe, shown);
  useSyncExternalStore(live.subscribe, live.version);
  const tl = player.getTime();
  const cue = cap?.enabled ? cueAt(cues, tl) : undefined;
  const texts = textOverlays.filter((o) => tl >= o.tlStartUs && tl < o.tlEndUs);
  const fade = (o: (typeof texts)[number]) => {
    let a = o.transform.opacity;
    if (o.fadeInUs > 0) a *= Math.min(1, (tl - o.tlStartUs) / o.fadeInUs);
    if (o.fadeOutUs > 0) a *= Math.min(1, (o.tlEndUs - tl) / o.fadeOutUs);
    return Math.max(0, a);
  };
  return (
    <div className="stage-layers" aria-hidden="true">
      {texts.map((o) => (
        <div
          key={o.id}
          data-ov={o.id}
          className={"stage-text" + (o.style.box ? " box" : "") + (o.id === editor.selectedOverlayId ? " selected" : "")}
          style={{
            left: `${(0.5 + (live.get(o.id) ?? o.transform).x) * 100}%`,
            top: `${(0.5 + (live.get(o.id) ?? o.transform).y) * 100}%`,
            fontSize: `${o.style.size * (live.get(o.id) ?? o.transform).scale * 100}cqh`,
            color: o.style.color,
            fontWeight: o.style.bold ? 700 : 400,
            opacity: fade(o),
          }}
        >
          {o.text}
        </div>
      ))}
      {cue && (
        <div className={"stage-caption " + (cap.position ?? "bottom") + (cap.box ? " box" : "")} style={{ fontSize: `${(cap.size ?? 0.05) * 100}cqh` }}>
          <span>{cue.text}</span>
        </div>
      )}
    </div>
  );
}

type LayerDrag = "move" | "tl" | "tr" | "bl" | "br" | "crop-l" | "crop-r" | "crop-t" | "crop-b";

/**
 * The selected picture or overlay video, outlined on the preview. Drag it to
 * move it, drag a corner to resize it, or press Crop and drag an edge inwards.
 */
function LayerBox({ editor, clip, main = false }: { editor: Editor; clip: Clip; main?: boolean }) {
  const { plan } = editor;
  const seg = plan.segments.find((sg) => sg.clipId === clip.id);
  const ref = useRef<HTMLDivElement>(null);
  const [t, setT] = useState(clip.transform);
  const [cropping, setCropping] = useState(false);
  const drag = useRef<{ mode: LayerDrag; x: number; y: number; start: Clip["transform"]; moved: boolean } | null>(null);
  useEffect(() => setT(clip.transform), [clip.transform]);
  // The main recording is shown unzoomed while it is being placed, like a zoom box.
  useEffect(() => {
    if (!main) return;
    editor.player.setCameraEnabled(false);
    return () => editor.player.setCameraEnabled(true);
  }, [editor.player, main]);
  // A main clip shows its box only while the playhead is on it.
  const tl = useSyncExternalStore(editor.player.subscribe, editor.player.getTime);
  if (!seg || !seg.hasVideo) return null;
  if (main && !plan.segments.some((sg) => sg.clipId === clip.id && tl >= sg.tlStartUs && tl < sg.tlEndUs)) return null;
  const stageAspect = plan.width / plan.height;
  const { visible } = layerBoxes(t, seg.aspect, stageAspect);

  const down = (mode: LayerDrag) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, x: e.clientX, y: e.clientY, start: t, moved: false };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    const stage = ref.current?.parentElement?.getBoundingClientRect();
    if (!d || !stage) return;
    const dx = (e.clientX - d.x) / stage.width;
    const dy = (e.clientY - d.y) / stage.height;
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
    if (!d.moved) return;
    const s = d.start;
    const full = layerBoxes(s, seg.aspect, stageAspect).full;
    const [cx, cy, cw, ch] = s.crop;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    if (d.mode === "move") setT({ ...s, x: clamp(s.x + dx, -0.95, 0.95), y: clamp(s.y + dy, -0.95, 0.95) });
    else if (d.mode === "crop-l") {
      const left = clamp(cx + dx / full[2], 0, cx + cw - 0.05);
      setT({ ...s, crop: [left, cy, cx + cw - left, ch] });
    } else if (d.mode === "crop-r") setT({ ...s, crop: [cx, cy, clamp(cw + dx / full[2], 0.05, 1 - cx), ch] });
    else if (d.mode === "crop-t") {
      const top = clamp(cy + dy / full[3], 0, cy + ch - 0.05);
      setT({ ...s, crop: [cx, top, cw, cy + ch - top] });
    } else if (d.mode === "crop-b") setT({ ...s, crop: [cx, cy, cw, clamp(ch + dy / full[3], 0.05, 1 - cy)] });
    else {
      // A corner: grow or shrink about the centre, following the pointer.
      const sign = d.mode === "tr" || d.mode === "br" ? 1 : -1;
      const half = full[2] / 2;
      setT({ ...s, scale: clamp(s.scale * ((half + sign * dx) / half), 0.05, main ? 3 : 2) });
    }
  };
  // A gesture the system takes away (a touch cancelled, capture lost) puts things back without saving.
  const cancel = () => { if (drag.current) { setT(drag.current.start); drag.current = null; } };
  const up = (e: React.PointerEvent) => {
    e.stopPropagation();
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    // On the main recording, a click that does not drag plays or pauses, as it does elsewhere on the preview.
    if (!d.moved) {
      if (main && d.mode === "move") editor.player.toggle();
      return;
    }
    const round = (v: number) => Math.round(v * 10000) / 10000;
    const next = { x: round(t.x), y: round(t.y), scale: round(t.scale), crop: t.crop.map(round) as Clip["transform"]["crop"] };
    const s = clip.transform;
    const same = next.x === round(s.x) && next.y === round(s.y) && next.scale === round(s.scale) && next.crop.every((v, i) => v === round(s.crop[i]!));
    if (!same) void editor.run(d.mode === "move" ? "Move on screen" : d.mode.startsWith("crop") ? "Crop" : "Resize", [{ op: "clip.set", clipId: clip.id, transform: next }]);
  };
  const handle = (mode: LayerDrag) => <b key={mode} className={"h " + mode} onPointerDown={down(mode)} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} />;
  const isCropped = t.crop[2] < 0.999 || t.crop[3] < 0.999;
  return (
    <div
      ref={ref} className={"layer-box" + (cropping ? " cropping" : "") + (main ? " main" : "")}
      style={{ left: `${visible[0] * 100}%`, top: `${visible[1] * 100}%`, width: `${visible[2] * 100}%`, height: `${visible[3] * 100}%` }}
      onPointerDown={down("move")} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} onClick={(e) => e.stopPropagation()}
    >
      <div className="layer-tools" onPointerDown={(e) => e.stopPropagation()}>
        <button className={cropping ? "on" : ""} onClick={() => setCropping(!cropping)}>{cropping ? "Done cropping" : "Crop"}</button>
        {isCropped && <button onClick={() => void editor.run("Remove crop", [{ op: "clip.set", clipId: clip.id, transform: { crop: [0, 0, 1, 1] } }])}>Reset crop</button>}
        {main && (Math.abs(t.scale - 1) > 0.001 || Math.abs(t.x) > 0.001 || Math.abs(t.y) > 0.001) && <button onClick={() => void editor.run("Reset size and position", [{ op: "clip.set", clipId: clip.id, transform: { x: 0, y: 0, scale: 1 } }])}>Reset size</button>}
      </div>
      {(cropping ? (["crop-l", "crop-r", "crop-t", "crop-b"] as const) : (["tl", "tr", "bl", "br"] as const)).map(handle)}
    </div>
  );
}

/**
 * The selected text or graphic, outlined on the preview while it is showing. Drag it to move it; drag a
 * corner to make it bigger or smaller. It follows the pointer and is saved once, on release.
 */
function OverlayBox({ editor, overlay }: { editor: Editor; overlay: Overlay }) {
  const { plan, player } = editor;
  const ref = useRef<HTMLDivElement>(null);
  const [t, setT] = useState(overlay.transform);
  /** Text only: its size on screen at scale 1, as fractions of the picture. */
  const [unit, setUnit] = useState<[number, number] | null>(null);
  const drag = useRef<{ mode: "move" | "tl" | "tr" | "bl" | "br"; x: number; y: number; start: Overlay["transform"]; moved: boolean; d0: number } | null>(null);
  useEffect(() => setT(overlay.transform), [overlay.transform]);
  useEffect(() => () => live.clear(overlay.id), [overlay.id]);
  const tl = useSyncExternalStore(player.subscribe, player.getTime);
  const span = plan.overlays.find((o) => o.id === overlay.id);
  const showing = Boolean(span && tl >= span.tlStartUs && tl < span.tlEndUs);
  const isText = overlay.kind === "text";
  // Measure the text as drawn (not while dragging: it is being resized then).
  useLayoutEffect(() => {
    if (!isText || !showing || drag.current) return;
    const stage = ref.current?.parentElement ?? document.querySelector<HTMLElement>(".stage");
    const el = stage?.querySelector<HTMLElement>(`[data-ov="${overlay.id}"]`);
    if (!stage || !el) return;
    const r = el.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const sc = overlay.transform.scale || 1;
    const next: [number, number] = [r.width / s.width / sc, r.height / s.height / sc];
    if (!unit || Math.abs(unit[0] - next[0]) > 0.002 || Math.abs(unit[1] - next[1]) > 0.002) setUnit(next);
  });
  if (!showing) return null;
  if (isText && !unit) return <div ref={ref} style={{ display: "none" }} />;
  const w = isText ? unit![0] * t.scale : t.scale;
  const h = isText ? unit![1] * t.scale : t.scale;
  const cx = 0.5 + t.x;
  const cy = 0.5 + t.y;

  const down = (mode: "move" | "tl" | "tr" | "bl" | "br") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const stage = ref.current?.parentElement?.getBoundingClientRect();
    const d0 = stage ? Math.hypot(e.clientX - (stage.left + cx * stage.width), e.clientY - (stage.top + cy * stage.height)) : 1;
    drag.current = { mode, x: e.clientX, y: e.clientY, start: t, moved: false, d0: Math.max(4, d0) };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    const stage = ref.current?.parentElement?.getBoundingClientRect();
    if (!d || !stage) return;
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
    if (!d.moved) return;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const s = d.start;
    let next: Overlay["transform"];
    if (d.mode === "move") {
      const lim = isText ? 0.5 : 0.95;
      next = { ...s, x: clamp(s.x + (e.clientX - d.x) / stage.width, -lim, lim), y: clamp(s.y + (e.clientY - d.y) / stage.height, -lim, lim) };
    } else {
      // Corners grow or shrink about the middle, following how far the pointer is from it.
      const dist = Math.hypot(e.clientX - (stage.left + (0.5 + s.x) * stage.width), e.clientY - (stage.top + (0.5 + s.y) * stage.height));
      next = { ...s, scale: clamp(s.scale * (dist / d.d0), isText ? 0.2 : 0.1, isText ? 6 : 1.5) };
    }
    setT(next);
    live.set(overlay.id, next);
    if (!isText) player.refresh();
  };
  const finish = (save: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      live.clear(overlay.id);
      if (save && d.mode === "move") player.toggle();
      return;
    }
    if (!save) {
      setT(d.start);
      live.clear(overlay.id);
      if (!isText) player.refresh();
      return;
    }
    const round = (v: number) => Math.round(v * 10000) / 10000;
    const what = isText ? "text" : "graphic";
    void editor.run(d.mode === "move" ? `Move ${what} on screen` : `Resize ${what}`, [
      { op: "overlay.set", overlayId: overlay.id, transform: { x: round(t.x), y: round(t.y), scale: round(t.scale) } } as never,
    ]).finally(() => {
      live.clear(overlay.id);
      if (!isText) player.refresh();
    });
  };
  const up = (e: React.PointerEvent) => {
    e.stopPropagation();
    finish(true);
  };
  const handle = (mode: "tl" | "tr" | "bl" | "br") => <b key={mode} className={"h " + mode} onPointerDown={down(mode)} onPointerMove={move} onPointerUp={up} onPointerCancel={() => finish(false)} />;
  return (
    <div
      ref={ref} className={"layer-box overlay-box" + (isText ? " text" : "")}
      style={{ left: `${(cx - w / 2) * 100}%`, top: `${(cy - h / 2) * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }}
      onPointerDown={down("move")} onPointerMove={move} onPointerUp={up} onPointerCancel={() => finish(false)} onClick={(e) => e.stopPropagation()}
      title="Drag to move. Drag a corner to make it bigger or smaller."
    >
      {(["tl", "tr", "bl", "br"] as const).map(handle)}
    </div>
  );
}

/** The box of the selected zoom, drawn over the whole picture so it can be dragged into place. */
function ZoomBox({ editor, zoom }: { editor: Editor; zoom: Zoom }) {
  const box = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState(zoom.rect);
  const drag = useRef<{ mode: "move" | "size"; x: number; y: number; start: Zoom["rect"] } | null>(null);
  useEffect(() => setRect(zoom.rect), [zoom.rect]);
  useEffect(() => {
    editor.player.setCameraEnabled(false);
    return () => editor.player.setCameraEnabled(true);
  }, [editor.player]);

  const down = (mode: "move" | "size") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, x: e.clientX, y: e.clientY, start: rect };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    const stage = box.current?.parentElement?.getBoundingClientRect();
    if (!d || !stage) return;
    const dx = (e.clientX - d.x) / stage.width;
    const dy = (e.clientY - d.y) / stage.height;
    const [x, y, w, h] = d.start;
    if (d.mode === "move") setRect([Math.max(0, Math.min(1 - w, x + dx)), Math.max(0, Math.min(1 - h, y + dy)), w, h]);
    else setRect([x, y, Math.max(0.05, Math.min(1 - x, w + dx)), Math.max(0.05, Math.min(1 - y, h + dy))]);
  };
  const cancel = () => { if (drag.current) { setRect(drag.current.start); drag.current = null; } };
  const up = (e: React.PointerEvent) => {
    e.stopPropagation();
    if (!drag.current) return;
    drag.current = null;
    const r = rect.map((v) => Math.round(v * 10000) / 10000) as Zoom["rect"];
    if (r.some((v, i) => Math.abs(v - zoom.rect[i]!) > 0.0005)) void editor.run("Move zoom target", [{ op: "zoom.set", zoomId: zoom.id, rect: r }]);
  };
  return (
    <div
      ref={box} className="zoom-box" onPointerDown={down("move")} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} onClick={(e) => e.stopPropagation()}
      style={{ left: `${rect[0] * 100}%`, top: `${rect[1] * 100}%`, width: `${rect[2] * 100}%`, height: `${rect[3] * 100}%` }}
    >
      <span>Zoom target</span>
      <b onPointerDown={down("size")} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} />
    </div>
  );
}

function ZoomInspector({ editor, zoom }: { editor: Editor; zoom: Zoom }) {
  const z = editor.project.settings.zoom;
  const set = (summary: string, patch: Record<string, unknown>) => void editor.run(summary, [{ op: "zoom.set", zoomId: zoom.id, ...patch } as never]);
  const num = (label: string, value: number, min: number, max: number, step: number, onChange: (v: number) => void, unit: string) => (
    <label className="field">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} defaultValue={value} key={value} onPointerUp={(e) => onChange(Number((e.target as HTMLInputElement).value))} onKeyUp={(e) => onChange(Number((e.target as HTMLInputElement).value))} />
      <output>{value.toFixed(1)}{unit}</output>
    </label>
  );
  return (
    <div className="inspector">
      <h2>Zoom</h2>
      <p className="empty">Drag the box on the preview onto what should fill the screen. Drag its corner to resize.</p>
      <dl>
        <dt>Holds for</dt>
        <dd>{clock(zoom.endUs - zoom.startUs, 1)}</dd>
        <dt>Added by</dt>
        <dd>{zoom.by === "agent" ? "Hermes" : "you"}</dd>
      </dl>
      {num("Zoom in over", (zoom.inUs ?? z.inUs) / 1e6, 0.3, 4, 0.1, (v) => set("Change zoom-in time", { inUs: Math.round(v * 1e6) }), " s")}
      {num("Zoom out over", (zoom.outUs ?? z.outUs) / 1e6, 0.3, 4, 0.1, (v) => set("Change zoom-out time", { outUs: Math.round(v * 1e6) }), " s")}
      {num("Closest allowed", zoom.maxScale ?? z.maxScale, 1.2, 4, 0.1, (v) => set("Change zoom strength", { maxScale: v }), "×")}
      <div className="row">
        <button onClick={() => void editor.run("Remove zoom", [{ op: "zoom.remove", zoomId: zoom.id }])}>Remove zoom</button>
        <button className="ghost" onClick={() => editor.selectZoom(null)}>Done</button>
      </div>
    </div>
  );
}

function OverlayInspector({ editor, overlay }: { editor: Editor; overlay: Overlay }) {
  const set = (summary: string, patch: Record<string, unknown>) => void editor.run(summary, [{ op: "overlay.set", overlayId: overlay.id, ...patch } as never]);
  const sec = (us: number) => (us / 1e6).toFixed(1);
  return (
    <div className="inspector">
      <h2>{overlay.kind === "text" ? "Text" : "HyperFrames overlay"}</h2>
      {overlay.kind === "text" ? (
        <label className="field wide">
          <span>Text</span>
          <textarea key={overlay.text} defaultValue={overlay.text} rows={2} onBlur={(e) => e.target.value.trim() && e.target.value !== overlay.text && set("Change text", { text: e.target.value })} />
        </label>
      ) : (
        <>
          <dl>
            <dt>Template</dt>
            <dd>{overlay.template}</dd>
            <dt>State</dt>
            <dd>{editor.renderedOverlays[overlay.id] ? "Rendered" : "Rendering with HyperFrames… (about half a minute)"}</dd>
          </dl>
          {Object.entries(overlay.params ?? {}).map(([k, v]) => (
            <label key={k} className="field">
              <span>{k[0]!.toUpperCase() + k.slice(1)}</span>
              {k === "color" ? (
                <input type="color" key={`${k}${v}`} defaultValue={v} onChange={(e) => set(`Change ${k}`, { params: { [k]: e.target.value } })} />
              ) : (
                <input type="text" key={`${k}${v}`} defaultValue={v} onBlur={(e) => e.target.value !== v && set(`Change ${k}`, { params: { [k]: e.target.value } })} />
              )}
            </label>
          ))}
        </>
      )}
      <label className="field">
        <span>Starts at (s)</span>
        <input type="number" step="0.1" min="0" key={`s${overlay.startUs}`} defaultValue={sec(overlay.startUs)} onBlur={(e) => set("Move text", { startUs: Math.max(0, Math.round(Number(e.target.value) * 1e6)) })} />
      </label>
      <label className="field">
        <span>Shows for (s)</span>
        <input type="number" step="0.1" min="0.1" key={`d${overlay.durationUs}`} defaultValue={sec(overlay.durationUs)} onBlur={(e) => set("Change text length", { durationUs: Math.max(100_000, Math.round(Number(e.target.value) * 1e6)) })} />
      </label>
      {overlay.kind === "text" && (
        <>
          <label className="field">
            <span>Size</span>
            <input type="range" min="0.02" max="0.2" step="0.005" key={`z${overlay.style.size}`} defaultValue={overlay.style.size} onPointerUp={(e) => set("Change text size", { style: { size: Number((e.target as HTMLInputElement).value) } })} />
          </label>
          <label className="field">
            <span>Height on screen</span>
            <input type="range" min="-0.45" max="0.45" step="0.01" key={`y${overlay.transform.y}`} defaultValue={overlay.transform.y} onPointerUp={(e) => set("Move text", { transform: { y: Number((e.target as HTMLInputElement).value) } })} />
          </label>
          <label className="field">
            <span>Colour</span>
            <input type="color" key={overlay.style.color} defaultValue={overlay.style.color} onChange={(e) => set("Change text colour", { style: { color: e.target.value } })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={overlay.style.box} onChange={(e) => set("Change text background", { style: { box: e.target.checked } })} /> Dark box behind
          </label>
        </>
      )}
      <div className="row">
        <button onClick={() => void editor.run("Remove text", [{ op: "overlay.remove", overlayId: overlay.id }])}>Remove</button>
        <button className="ghost" onClick={() => editor.selectOverlay(null)}>Done</button>
      </div>
    </div>
  );
}

/** Project-wide look of captions and the sound level, shown when nothing is selected. */
function ProjectSettings({ editor }: { editor: Editor }) {
  const cap = editor.project.settings.captions;
  const audio = editor.project.settings.audio ?? { normalize: false, targetLufs: -14 };
  const setCap = (summary: string, patch: Partial<typeof cap>) => void editor.run(summary, [{ op: "settings.set", settings: { captions: patch } } as never]);
  const hasWords = Object.keys(editor.transcripts).length > 0;
  const speed = editor.project.settings.mainSpeed ?? 1;
  const [usual, setUsual] = useState<number | null>(null);
  const [usualLufs, setUsualLufs] = useState<number | null | undefined>(undefined);
  useEffect(() => void api.preferences().then((p) => { setUsual(p.newProjectSpeed); setUsualLufs(p.newProjectLufs ?? null); }).catch(() => undefined), []);
  const setAudio = (summary: string, patch: Partial<typeof audio>) => void editor.run(summary, [{ op: "settings.set", settings: { audio: patch } } as never]);
  const levelHere = audio.normalize ? audio.targetLufs : null;
  return (
    <>
      <h3>Speed</h3>
      <label className="field">
        <span>Main track</span>
        <select value={String(speed)} onChange={(e) => void editor.run(`Speed ${e.target.value}×`, [{ op: "project.speed", speed: Number(e.target.value) } as never])}>
          {[...new Set([0.75, 1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.5, 2, speed])].sort((a, b) => a - b).map((v) => (
            <option key={v} value={String(v)}>{v}×</option>
          ))}
        </select>
      </label>
      <p className="dim small">Text, pictures, music and markers stay with the same moment of the recording. Voiceover and music keep their own speed.</p>
      {usual !== null && (
        <label className="check">
          <input
            type="checkbox" checked={Math.abs(usual - speed) < 1e-6}
            onChange={(e) => void api.setPreferences({ newProjectSpeed: e.target.checked ? speed : 1 }).then((p) => setUsual(p.newProjectSpeed))}
          /> Start new projects at {speed}×{Math.abs(usual - speed) >= 1e-6 ? ` (now ${usual}×)` : ""}
        </label>
      )}
      <h3>Captions</h3>
      <label className="check">
        <input type="checkbox" checked={cap.enabled} onChange={(e) => setCap(e.target.checked ? "Turn captions on" : "Turn captions off", { enabled: e.target.checked })} /> Burn captions into the video
      </label>
      {!hasWords && <p className="empty">Captions come from the transcript. Transcribe a take first.</p>}
      {cap.enabled && (
        <>
          <label className="field">
            <span>Size</span>
            <input type="range" min="0.03" max="0.1" step="0.005" key={`s${cap.size}`} defaultValue={cap.size} onPointerUp={(e) => setCap("Change caption size", { size: Number((e.target as HTMLInputElement).value) })} />
          </label>
          <label className="field">
            <span>Words at once</span>
            <input type="range" min="1" max="12" step="1" key={`w${cap.maxWords}`} defaultValue={cap.maxWords} onPointerUp={(e) => setCap("Change caption length", { maxWords: Number((e.target as HTMLInputElement).value) })} />
            <output>{cap.maxWords}</output>
          </label>
          <label className="field">
            <span>Where</span>
            <select value={cap.position} onChange={(e) => setCap("Move captions", { position: e.target.value as typeof cap.position })}>
              <option value="bottom">Bottom</option>
              <option value="middle">Middle</option>
              <option value="top">Top</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={cap.box} onChange={(e) => setCap("Change caption background", { box: e.target.checked })} /> Dark box behind
          </label>
          <label className="check">
            <input type="checkbox" checked={cap.uppercase} onChange={(e) => setCap("Change caption case", { uppercase: e.target.checked })} /> Capital letters
          </label>
        </>
      )}
      {hasWords && (
        <p>
          <a href={api.srtUrl(editor.pid)} download>Download captions (.srt)</a> <span className="dim">for uploading to YouTube instead of burning in</span>
        </p>
      )}
      <h3>Sound</h3>
      <label className="check">
        <input type="checkbox" checked={audio.normalize} onChange={(e) => setAudio(e.target.checked ? "Level sound on export" : "Stop levelling sound", { normalize: e.target.checked })} /> Level the loudness on export
      </label>
      {audio.normalize && (
        <label className="field">
          <span>Target</span>
          <select value={String(audio.targetLufs)} onChange={(e) => setAudio(`Level to ${e.target.value} LUFS`, { targetLufs: Number(e.target.value) })}>
            {[...new Set([-23, -16, -14, -12, audio.targetLufs])].sort((a, b) => a - b).map((v) => (
              <option key={v} value={String(v)}>{v} LUFS{v === -14 ? " (YouTube, Spotify)" : v === -16 ? " (podcasts, Apple)" : v === -23 ? " (broadcast)" : ""}</option>
            ))}
          </select>
        </label>
      )}
      <p className="dim small">The whole video is measured, then turned up or down by one amount, so quiet and loud parts keep their balance. The level reached is shown when the export finishes.</p>
      {usualLufs !== undefined && (
        <label className="check">
          <input
            type="checkbox" checked={usualLufs === levelHere}
            onChange={(e) => void api.setPreferences({ newProjectLufs: e.target.checked ? levelHere : null }).then((p) => setUsualLufs(p.newProjectLufs ?? null))}
          /> {levelHere === null ? "New projects start without levelling" : `New projects level to ${levelHere} LUFS`}{usualLufs !== levelHere ? ` (now ${usualLufs === null ? "off" : `${usualLufs} LUFS`})` : ""}
        </label>
      )}
    </>
  );
}

const PLACES: [string, { x: number; y: number; scale: number }][] = [
  ["Full screen", { x: 0, y: 0, scale: 1 }],
  ["Bottom right", { x: 0.33, y: 0.33, scale: 0.3 }],
  ["Bottom left", { x: -0.33, y: 0.33, scale: 0.3 }],
  ["Top right", { x: 0.33, y: -0.33, scale: 0.3 }],
  ["Top left", { x: -0.33, y: -0.33, scale: 0.3 }],
];

/** Volume, mute and fades: the same for any clip. */
function SoundAndFades({ editor, clip }: { editor: Editor; clip: Clip }) {
  const set = (summary: string, patch: Record<string, unknown>) => void editor.run(summary, [{ op: "clip.set", clipId: clip.id, ...patch } as never]);
  const media = editor.project.media.find((m) => m.id === clip.mediaId);
  return (
    <>
      {media?.probe.hasAudio && media.kind !== "image" && (
        <>
          <h3>Sound</h3>
          <label className="check">
            <input type="checkbox" checked={clip.muted} onChange={(e) => set(e.target.checked ? "Mute clip" : "Unmute clip", { muted: e.target.checked })} /> Mute
            {clip.muted && <span className="dim"> · record a voiceover to replace it</span>}
          </label>
          <label className="field">
            <span>Volume</span>
            <input type="range" min="-30" max="12" step="1" key={`v${clip.volumeDb}`} defaultValue={clip.volumeDb} onPointerUp={(e) => set("Change volume", { volumeDb: Number((e.target as HTMLInputElement).value) })} />
            <output>{clip.volumeDb > 0 ? "+" : ""}{clip.volumeDb} dB</output>
          </label>
        </>
      )}
      {media?.kind !== "image" && (
        <label className="field">
          <span>Speed</span>
          <select value={String(clip.speed)} onChange={(e) => set("Change speed", { speed: Number(e.target.value) })}>
            {[...new Set([0.25, 0.5, 0.75, 1, 1.1, 1.25, 1.5, 2, 3, 4, clip.speed])].sort((a, b) => a - b).map((v) => (
              <option key={v} value={String(v)}>{v}×</option>
            ))}
          </select>
        </label>
      )}
      <h3>Fades</h3>
      <label className="field">
        <span>Fade in (s)</span>
        <input type="number" min="0" max="10" step="0.1" key={`fi${clip.fadeInUs}`} defaultValue={(clip.fadeInUs / 1e6).toFixed(1)} onBlur={(e) => set("Change fade in", { fadeInUs: Math.max(0, Math.round(Number(e.target.value) * 1e6)) })} />
      </label>
      <label className="field">
        <span>Fade out (s)</span>
        <input type="number" min="0" max="10" step="0.1" key={`fo${clip.fadeOutUs}`} defaultValue={(clip.fadeOutUs / 1e6).toFixed(1)} onBlur={(e) => set("Change fade out", { fadeOutUs: Math.max(0, Math.round(Number(e.target.value) * 1e6)) })} />
      </label>
    </>
  );
}

/** Where a clip sits on screen: presets, size, crop and (for layers) opacity. The main recording uses it too. */
function OnScreen({ editor, clip }: { editor: Editor; clip: Clip }) {
  const set = (summary: string, patch: Record<string, unknown>) => void editor.run(summary, [{ op: "clip.set", clipId: clip.id, ...patch } as never]);
  const t = clip.transform;
  const main = editor.clips.includes(clip);
  const places = main ? MAIN_PLACES : PLACES;
  const changed = Math.abs(t.x) > 0.001 || Math.abs(t.y) > 0.001 || Math.abs(t.scale - 1) > 0.001 || t.crop[0] > 0.001 || t.crop[1] > 0.001 || t.crop[2] < 0.999 || t.crop[3] < 0.999;
  const others = main ? editor.clips.filter((c) => c.id !== clip.id) : [];
  return (
    <>
      <h3>On screen</h3>
      {main && <p className="dim small">Select the clip and drag it on the preview to move it, a corner to resize, or press Crop there.</p>}
      <div className="row wrap">
        {places.map(([name, p]) => (
          <button key={name} className={Math.abs(t.x - p.x) < 0.01 && Math.abs(t.y - p.y) < 0.01 && Math.abs(t.scale - p.scale) < 0.01 ? "on" : ""} onClick={() => set(`Place: ${name}`, { transform: p })}>
            {name}
          </button>
        ))}
      </div>
      <label className="field">
        <span>Size</span>
        <input type="range" min="0.1" max={main ? "2" : "1"} step="0.01" key={`z${t.scale}`} defaultValue={t.scale} onPointerUp={(e) => set("Resize", { transform: { scale: Number((e.target as HTMLInputElement).value) } })} />
        <output>{Math.round(t.scale * 100)}%</output>
      </label>
      {(["left", "top", "right", "bottom"] as const).map((side, i) => {
        const [cx, cy, cw, ch] = t.crop;
        const value = [cx, cy, 1 - cx - cw, 1 - cy - ch][i]!;
        return (
          <label key={side} className="field">
            <span>Crop {side}</span>
            <input
              type="range" min="0" max="0.45" step="0.01" key={`${side}${value}`} defaultValue={value}
              onPointerUp={(e) => {
                const v = Number((e.target as HTMLInputElement).value);
                const edges = [cx, cy, 1 - cx - cw, 1 - cy - ch];
                edges[i] = v;
                const [l, tp, r, b] = edges as [number, number, number, number];
                set(`Crop ${side}`, { transform: { crop: [l, tp, Math.max(0.05, 1 - l - r), Math.max(0.05, 1 - tp - b)] } });
              }}
            />
          </label>
        );
      })}
      {!main && (
        <label className="field">
          <span>Opacity</span>
          <input type="range" min="0.1" max="1" step="0.05" key={`o${t.opacity}`} defaultValue={t.opacity} onPointerUp={(e) => set("Change opacity", { transform: { opacity: Number((e.target as HTMLInputElement).value) } })} />
        </label>
      )}
      <div className="row wrap">
        {changed && <button onClick={() => set("Reset position, size and crop", { transform: { x: 0, y: 0, scale: 1, crop: [0, 0, 1, 1] } })}>Reset</button>}
        {main && others.length > 0 && (
          <button
            title="Give every clip on the main track this position, size and crop"
            onClick={() => void editor.run("Same position, size and crop for all main clips", others.map((c) => ({ op: "clip.set" as const, clipId: c.id, transform: { x: t.x, y: t.y, scale: t.scale, crop: t.crop } })))}
          >
            Apply to all main clips
          </button>
        )}
      </div>
    </>
  );
}

/** Ways to frame the main recording. */
const MAIN_PLACES: [string, Partial<Clip["transform"]> & { x: number; y: number; scale: number }][] = [
  ["Full", { x: 0, y: 0, scale: 1, crop: [0, 0, 1, 1] }],
  ["Left half", { x: -0.25, y: 0, scale: 0.5 }],
  ["Right half", { x: 0.25, y: 0, scale: 0.5 }],
  ["Inset", { x: 0, y: 0, scale: 0.85 }],
];

/** A clip on a video or audio track: where it sits in time and on screen. */
function LayerClipInspector({ editor, clip }: { editor: Editor; clip: Clip }) {
  const media = editor.project.media.find((m) => m.id === clip.mediaId);
  const track = editor.project.tracks.find((t) => t.items.includes(clip.id));
  const set = (summary: string, patch: Record<string, unknown>) => void editor.run(summary, [{ op: "clip.set", clipId: clip.id, ...patch } as never]);
  const t = clip.transform;
  const still = media?.kind === "image";
  return (
    <div className="inspector">
      <h2>{still ? "Picture" : track?.kind === "audio" ? "Audio clip" : "Overlay video"}</h2>
      <dl>
        <dt>File</dt>
        <dd title={media?.path}>{media ? baseName(media.path) : clip.mediaId}</dd>
        <dt>Track</dt>
        <dd>{track?.name || track?.id}</dd>
      </dl>
      <label className="field">
        <span>Starts at (s)</span>
        <input type="number" min="0" step="0.1" key={`s${clip.startUs}`} defaultValue={(clip.startUs / 1e6).toFixed(2)} onBlur={(e) => void editor.run("Move clip", [{ op: "clip.move", clipId: clip.id, startUs: Math.max(0, Math.round(Number(e.target.value) * 1e6)) }])} />
      </label>
      {still && (
        <label className="field">
          <span>Shows for (s)</span>
          <input type="number" min="0.1" step="0.1" key={`d${clip.sourceOutUs}`} defaultValue={((clip.sourceOutUs - clip.sourceInUs) / 1e6).toFixed(1)} onBlur={(e) => void editor.run("Change picture length", [{ op: "clip.trim", clipId: clip.id, sourceOutUs: clip.sourceInUs + Math.max(100_000, Math.round(Number(e.target.value) * 1e6)) }])} />
        </label>
      )}
      {track?.kind === "video" && <OnScreen editor={editor} clip={clip} />}
      <SoundAndFades editor={editor} clip={clip} />
      <div className="row">
        <button onClick={() => void editor.run("Remove clip", [{ op: "clip.remove", clipId: clip.id }])}>Remove</button>
        <button className="ghost" onClick={() => editor.selectClip(null)}>Done</button>
      </div>
    </div>
  );
}

export function Inspector({ editor }: { editor: Editor }) {
  const { project, selectedClipId, clips } = editor;
  const overlay = editor.selectedOverlayId ? project.items[editor.selectedOverlayId] : null;
  if (overlay && overlay.type === "overlay") return <OverlayInspector editor={editor} overlay={overlay} />;
  const zoom = editor.selectedZoomId ? project.items[editor.selectedZoomId] : null;
  if (zoom && zoom.type === "zoom") return <ZoomInspector editor={editor} zoom={zoom} />;
  const any = selectedClipId ? project.items[selectedClipId] : null;
  if (any && any.type === "clip" && !clips.includes(any)) return <LayerClipInspector editor={editor} clip={any} />;
  const clip = clips.find((c) => c.id === selectedClipId);
  if (!clip) {
    return (
      <div className="inspector">
        <h2>Details</h2>
        <p className="empty">Select a clip on the timeline to see its cuts and settings.</p>
        <ProjectSettings editor={editor} />
      </div>
    );
  }
  const media = project.media.find((m) => m.id === clip.mediaId);
  const index = clips.indexOf(clip);
  return (
    <div className="inspector">
      <h2>Clip</h2>
      <dl>
        <dt>File</dt>
        <dd title={media?.path}>{media ? baseName(media.path) : clip.mediaId}</dd>
        <dt>Uses</dt>
        <dd>{clock(clip.sourceInUs, 2)} to {clock(clip.sourceOutUs, 2)} of the take</dd>
      </dl>
      <SoundAndFades editor={editor} clip={clip} />
      {media?.probe.hasVideo && <OnScreen editor={editor} clip={clip} />}
      {media?.probe.hasAudio && !clip.muted && (
        <div className="row">
          <button
            title="Move this clip's sound to its own audio track, so it can be moved, faded or replaced separately"
            onClick={() => {
              const trackId = `a${Date.now().toString(36).slice(-5)}`;
              const pieces = editor.plan.segments.filter((sg) => sg.clipId === clip.id);
              const ops: Op[] = [
                { op: "track.add", kind: "audio", id: trackId, name: "Detached audio" },
                // One audio clip per kept piece, so the cuts carry over.
                ...pieces.map((sg) => ({ op: "clip.add" as const, trackId, mediaId: clip.mediaId, sourceInUs: sg.srcInUs, sourceOutUs: sg.srcOutUs, startUs: sg.tlStartUs })),
                { op: "clip.set", clipId: clip.id, muted: true },
              ];
              void editor.run("Detach audio", ops);
            }}
          >
            Detach audio
          </button>
        </div>
      )}
      {transitionCuts(editor).some((c) => c.clipId === clip.id && !c.inside) && (
        <>
          <h3>Transition in</h3>
          <div className="row">
            <select
              value={clip.transitionIn?.kind ?? ""} aria-label="Transition from the clip before"
              onChange={(e) => {
                const kind = e.target.value as TransitionKind | "";
                void editor.run(kind ? TRANSITION_NAMES[kind] : "Remove transition", [
                  { op: "clip.set", clipId: clip.id, transitionIn: kind ? { kind, durationUs: clip.transitionIn?.durationUs ?? 800_000 } : null },
                ]);
              }}
            >
              <option value="">None (plain cut)</option>
              {TRANSITION_KINDS.map((k) => <option key={k} value={k}>{TRANSITION_NAMES[k]}</option>)}
            </select>
            {clip.transitionIn && (
              <select
                value={String(clip.transitionIn.durationUs)} aria-label="Transition length"
                onChange={(e) => void editor.run("Change transition length", [{ op: "clip.set", clipId: clip.id, transitionIn: { kind: clip.transitionIn!.kind, durationUs: Number(e.target.value) } }])}
              >
                {[...new Set([300_000, 500_000, 800_000, 1_000_000, 1_500_000, 2_000_000, clip.transitionIn.durationUs])].sort((a, b) => a - b).map((d) => (
                  <option key={d} value={String(d)}>{(d / 1e6).toFixed(1)} s</option>
                ))}
              </select>
            )}
          </div>
          <p className="dim small">Centred on the cut: half before, half after. The video keeps its length.</p>
        </>
      )}
      {index < clips.length - 1 && (
        <div className="row">
          <button
            title="Fade this clip out to black and the next one in from black"
            onClick={() => {
              const next = clips[index + 1]!;
              const on = !(clip.fadeOutUs > 0 && next.fadeInUs > 0);
              const d = on ? 400_000 : 0;
              void editor.run(on ? "Dip to black into the next clip" : "Remove dip to black", [
                { op: "clip.set", clipId: clip.id, fadeOutUs: d },
                { op: "clip.set", clipId: next.id, fadeInUs: d },
              ]);
            }}
          >
            {clip.fadeOutUs > 0 && clips[index + 1]!.fadeInUs > 0 ? "Remove dip to black" : "Dip to black into next clip"}
          </button>
        </div>
      )}
      <h3>Cuts in this clip ({clip.removed.length})</h3>
      {clip.removed.length === 0 && <p className="empty">No cuts. Shift-drag on the timeline, then press Cut.</p>}
      <ul className="cuts">
        {clip.removed.map((r) => (
          <li key={r.id}>
            <span>
              {clock(r.startUs, 2)} to {clock(r.endUs, 2)}
              <span className="dim"> · {clock(r.endUs - r.startUs, 2)} · {r.by === "agent" ? "Hermes" : "you"}</span>
            </span>
            <button className="ghost" onClick={() => void editor.run("Restore a cut", [{ op: "range.restore", clipId: clip.id, rangeIds: [r.id] }])}>
              Restore
            </button>
          </li>
        ))}
      </ul>
      {clip.removed.length > 1 && (
        <button onClick={() => void editor.run("Restore all cuts in clip", [{ op: "range.restore", clipId: clip.id, rangeIds: clip.removed.map((r) => r.id) }])}>
          Restore all
        </button>
      )}
    </div>
  );
}
