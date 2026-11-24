import { sourceToTimeline, timelineToSource, TRANSITION_KINDS, type Op, type Plan, type TransitionKind, type Zoom } from "@sous-chef/core";
import { planIndex } from "./timeIndex";
import { Icon } from "./icons";
import { defaultLength, label, TRANSITION_HINTS, TRANSITION_NAMES, transitionCuts, transitionOps, type Cut } from "./transitions";
import { createPortal } from "react-dom";
import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { clipSpans } from "./actions";
import { api } from "./api";
import { local } from "./storage";
import { baseName, clock, S } from "./time";
import { getSheet, getWave, type PreparedMap } from "./trackData";
import type { Editor } from "./useEditor";
import { draggedMedia, placeMedia } from "./dragMedia";

const PAD = 16;
const MIN_PPS = 2;
const MAX_PPS = 400;
const TRACK_H = 72;
const THUMB_H = 44;

function tickStep(pps: number): number {
  for (const s of [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]) if (s * pps >= 70) return s;
  return 1200;
}

/**
 * Snapping. Given where the edges of a dragged thing would land, finds the
 * nearest cut, clip edge, marker or the playhead within 8 pixels and says how
 * far to nudge to meet it and where to draw the guide line. Alt drags freely.
 */
function snapEdges(editor: Editor, edges: number[], pps: number, skipId: string, free: boolean, mainFirst = false): { deltaUs: number; lineUs: number | null } {
  if (free) return { deltaUs: 0, lineUs: null };
  if (mainFirst) {
    // A main clip being moved joins up with its neighbours before it snaps to anything else.
    const ends: number[] = [0];
    for (const sp of clipSpans(editor.plan)) if (sp[0] !== skipId) ends.push(sp[1].startUs, sp[1].endUs);
    let hit: { deltaUs: number; lineUs: number | null } | null = null;
    let near = (8 / pps) * S;
    for (const p of ends) for (const edge of edges) if (Math.abs(p - edge) < near) {
      near = Math.abs(p - edge);
      hit = { deltaUs: p - edge, lineUs: p };
    }
    if (hit) return hit;
  }
  const points = [0, editor.player.tlUs, ...editor.project.markers.map((m) => m.timeUs)];
  for (const s of editor.plan.segments) {
    if (s.clipId === skipId) continue;
    // On the main track every cut is a place to snap to, not only the clip's ends.
    points.push(s.trackKind === "main" ? s.tlStartUs : s.clipStartUs, s.trackKind === "main" ? s.tlEndUs : s.clipEndUs);
  }
  for (const o of editor.plan.overlays) if (o.id !== skipId) points.push(o.tlStartUs, o.tlEndUs);
  for (const c of editor.plan.camera) if (c.zoomId !== skipId) points.push(c.tlStartUs, c.tlEndUs);
  let best = { deltaUs: 0, lineUs: null as number | null };
  let bestD = (8 / pps) * S;
  for (const p of points) {
    for (const edge of edges) {
      const d = Math.abs(p - edge);
      if (d < bestD) {
        bestD = d;
        best = { deltaUs: p - edge, lineUs: p };
      }
    }
  }
  return best;
}

/** Where a dragged block of a given length ends up, and the guide line to show. */
function snapMove(editor: Editor, startUs: number, lengthUs: number, pps: number, skipId: string, free: boolean, mainFirst = false): { us: number; lineUs: number | null } {
  const from = Math.max(0, startUs);
  const sn = snapEdges(editor, [from, from + lengthUs], pps, skipId, free, mainFirst);
  const us = Math.max(0, Math.round(from + sn.deltaUs));
  return { us, lineUs: us === Math.round(from + sn.deltaUs) ? sn.lineUs : null };
}

/** How long each graphic shows when added, in seconds; others get 4. */
const GRAPHIC_SECONDS: Record<string, number> = { callout: 3, "end-card": 10, quote: 5, highlight: 3, arrow: 3, keys: 3 };

/** Puts a transition on a cut (or removes it) and leaves the playhead just before it, so Play shows it. */
function applyTransition(editor: Editor, cut: Cut, kind: TransitionKind | null, durationUs?: number): void {
  const len = Math.min(durationUs ?? cut.transition?.durationUs ?? (kind ? defaultLength(kind) : 0), Math.max(200_000, cut.roomUs));
  const ops = transitionOps(cut, kind ? { kind, durationUs: len } : null);
  if (!ops.length) return;
  void editor.run(label(kind, cut.atUs, clock), ops).then((ok) => {
    if (ok && kind) editor.player.seek(Math.max(0, cut.atUs - len / 2 - 1_000_000));
  });
}

const LENGTHS = [300_000, 500_000, 800_000, 1_000_000, 1_500_000, 2_000_000];

/**
 * A marker on every cut of the main track, sitting across the cut. Empty cuts show a small diamond on
 * hover; a cut with a transition shows a bar as long as the transition. Click either to pick one.
 */
function TransitionKnobs({ editor, pps }: { editor: Editor; pps: number }) {
  const cuts = transitionCuts(editor);
  const [open, setOpen] = useState<{ at: number; x: number; y: number } | null>(null);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!pop.current?.contains(t) && !t.closest?.(".tr-knob")) setOpen(null);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("pointerdown", away); window.removeEventListener("keydown", esc); };
  }, [open]);
  const cut = open ? cuts.find((c) => Math.abs(c.atUs - open.at) < 1000) : null;
  return (
    <>
      {cuts.map((c) => {
        const t = c.transition;
        const w = t ? Math.max(18, (t.durationUs / S) * pps) : 16;
        const isOpen = Boolean(open && Math.abs(open.at - c.atUs) < 1000);
        return (
          <button
            key={c.atUs}
            className={"tr-knob" + (t ? " on" : "") + (isOpen ? " open" : "")}
            style={{ left: PAD + (c.atUs / S) * pps - w / 2, width: w }}
            title={t ? `${TRANSITION_NAMES[t.kind]}, ${(t.durationUs / 1e6).toFixed(1)} s. Click to change.` : "Add a transition on this cut"}
            aria-label={t ? `${TRANSITION_NAMES[t.kind]} at ${clock(c.atUs)}` : `Add a transition at ${clock(c.atUs)}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setOpen(isOpen ? null : { at: c.atUs, x: r.left + r.width / 2, y: r.top });
            }}
          >
            {t ? <Icon name="transition" size={12} /> : <i />}
          </button>
        );
      })}
      {open && cut && createPortal(
        <div ref={pop} className="tr-pop" role="dialog" aria-label="Transition" style={{ left: Math.max(160, Math.min(window.innerWidth - 160, open.x)), top: open.y - 10 }}>
          <div className="tr-pop-head">
            <strong>Transition at {clock(cut.atUs)}</strong>
            <span>{cut.inside ? "Where a stretch was cut out" : "Between two clips"}</span>
          </div>
          <div className="tr-kinds">
            {TRANSITION_KINDS.map((k) => (
              <button key={k} className={cut.transition?.kind === k ? "on" : ""} title={TRANSITION_HINTS[k]} onClick={() => applyTransition(editor, cut, k)}>
                <span className={"tr-swatch " + k} />
                {TRANSITION_NAMES[k]}
              </button>
            ))}
          </div>
          {cut.transition && (
            <>
              <div className="tr-lengths" role="group" aria-label="Length">
                {LENGTHS.filter((d) => d <= Math.max(cut.roomUs, 300_000)).map((d) => (
                  <button key={d} className={Math.abs(cut.transition!.durationUs - d) < 20_000 ? "on" : ""} onClick={() => applyTransition(editor, cut, cut.transition!.kind, d)}>{(d / 1e6).toFixed(1)} s</button>
                ))}
              </div>
              <div className="tr-foot">
                <button className="ghost" onClick={() => { editor.player.seek(Math.max(0, cut.atUs - cut.transition!.durationUs / 2 - 1_000_000)); editor.player.play(); }}><Icon name="play" size={12} /> Play it</button>
                <span className="grow" />
                <button className="ghost danger" onClick={() => { applyTransition(editor, cut, null); setOpen(null); }}>Remove</button>
              </div>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

type EdgeMode = "move" | "in" | "out";

/** Which part of a block a press landed on: one of its edges, or the body (move). */
function edgeOf(e: React.PointerEvent): EdgeMode {
  const edge = (e.target as HTMLElement).dataset?.edge;
  return edge === "in" || edge === "out" ? edge : "move";
}

/** A block's position and width while one of its edges or the whole of it is being dragged. */
function edgeStyle(left: number, width: number, dx: number, mode: EdgeMode): CSSProperties {
  if (mode === "in") return { left: left + dx, width: Math.max(8, width - dx) };
  if (mode === "out") return { left, width: Math.max(8, width + dx) };
  return { left: left + dx, width: Math.max(8, width) };
}

/** Shortest a block can be made by dragging an edge. */
const MIN_EDGE_US = 200_000;

/**
 * Where a dragged edge lands (snapped to cuts, clip edges, markers and the playhead), as a pixel offset,
 * kept at least MIN_EDGE_US long and within `limitUs` of growth when the source runs out.
 */
function edgeDrag(editor: Editor, startUs: number, endUs: number, mode: "in" | "out", rawPx: number, pps: number, skipId: string, free: boolean, limitUs: number | null): { dx: number; lineUs: number | null } {
  const edge = mode === "in" ? startUs : endUs;
  const sn = snapEdges(editor, [edge + (rawPx / pps) * S], pps, skipId, free);
  let to = edge + (rawPx / pps) * S + sn.deltaUs;
  let line = sn.lineUs;
  const clampTo = (v: number) => {
    if (v !== to) line = null;
    to = v;
  };
  if (mode === "in") {
    clampTo(Math.max(0, Math.min(to, endUs - MIN_EDGE_US)));
    if (limitUs !== null) clampTo(Math.max(to, startUs - limitUs));
  } else {
    clampTo(Math.max(to, startUs + MIN_EDGE_US));
    if (limitUs !== null) clampTo(Math.min(to, endUs + limitUs));
  }
  return { dx: ((to - edge) / S) * pps, lineUs: line };
}

/** How much longer (in timeline time) a video or sound clip can get at one end before its file runs out. */
function maxGrow(editor: Editor, c: { mediaId: string; sourceInUs: number; sourceOutUs: number; speed: number }, mode: "in" | "out"): number {
  const media = editor.project.media.find((m) => m.id === c.mediaId);
  if (!media) return 0;
  return mode === "in" ? c.sourceInUs / c.speed : Math.max(0, media.durationUs - c.sourceOutUs) / c.speed;
}

/** A video or audio track: its clips sit at their own times. Drag to move; click to select. */
function TrackLane({ editor, pps, trackId, onSnap }: { editor: Editor; pps: number; trackId: string; onSnap: (us: number | null) => void }) {
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; dx: number; dy: number; mode: EdgeMode } | null>(null);
  const track = editor.project.tracks.find((t) => t.id === trackId)!;
  /** The lane of this lane's kind under the pointer, for dragging a clip to another lane. */
  const laneUnder = (x: number, y: number): string | null => {
    for (const el of document.elementsFromPoint(x, y)) {
      const id = (el as HTMLElement).dataset?.track;
      if (!id) continue;
      const t = editor.project.tracks.find((tr) => tr.id === id);
      return t && t.kind === track.kind ? id : null;
    }
    return null;
  };
  const spans = new Map<string, { start: number; end: number; still: boolean }>();
  for (const s of editor.plan.segments) {
    if (s.trackId !== trackId) continue;
    spans.set(s.clipId, { start: s.clipStartUs, end: s.clipEndUs, still: s.still });
  }
  return (
    <div className={"lane track-lane " + track.kind} aria-label={track.name || track.kind} data-track={trackId}>
      <span className="lane-name" title={track.name}>{track.kind === "audio" ? "Audio" : "Video"}</span>
      {track.items.map((id) => {
        const c = editor.project.items[id];
        const span = spans.get(id);
        if (!c || c.type !== "clip" || !span) return null;
        const media = editor.project.media.find((m) => m.id === c.mediaId);
        const dx = drag?.id === id ? drag.dx : 0;
        const dy = drag?.id === id && drag.mode === "move" ? drag.dy : 0;
        const mode = drag?.id === id ? drag.mode : "move";
        const w = ((span.end - span.start) / S) * pps;
        return (
          <div
            key={id}
            className={"layer-block " + track.kind + (span.still ? " still" : "") + (id === editor.selectedClipId ? " selected" : "") + (c.link ? " linked" : "") + (dy ? " lifting" : "")}
            style={{ ...edgeStyle(PAD + (span.start / S) * pps, w, dx, mode), ...(dy ? { transform: `translateY(${dy}px)`, zIndex: 5 } : {}) }}
            title={`${media ? baseName(media.path) : id}.${c.link ? " Locked to the video: it moves with the footage under it." : ""} Drag to move (up or down to another lane), drag an edge to make it longer or shorter.`}
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              setDrag({ id, x: e.clientX, y: e.clientY, dx: 0, dy: 0, mode: edgeOf(e) });
              editor.selectZoom(null);
              editor.selectOverlay(null);
              editor.selectClip(id);
            }}
            onPointerMove={(e) => {
              if (drag?.id !== id) return;
              const raw = e.clientX - drag.x;
              if (drag.mode !== "move") {
                const r = edgeDrag(editor, span.start, span.end, drag.mode, raw, pps, id, e.altKey, span.still ? null : maxGrow(editor, c, drag.mode));
                setDrag({ ...drag, dx: r.dx });
                onSnap(Math.abs(raw) > 3 ? r.lineUs : null);
                return;
              }
              const sn = snapMove(editor, span.start + (raw / pps) * S, span.end - span.start, pps, id, e.altKey);
              const rawY = e.clientY - drag.y;
              setDrag({ ...drag, dx: ((sn.us - span.start) / S) * pps, dy: Math.abs(rawY) > 8 ? rawY : 0 });
              onSnap(Math.abs(raw) > 3 ? sn.lineUs : null);
            }}
            onPointerCancel={() => { onSnap(null); if (drag?.id === id) setDrag(null); }}
            onLostPointerCapture={() => { if (drag?.id === id) { onSnap(null); setDrag(null); } }}
            onPointerUp={(e) => {
              e.stopPropagation();
              onSnap(null);
              if (drag?.id !== id) return;
              setDrag(null);
              const toLane = drag.mode === "move" && drag.dy ? laneUnder(e.clientX, e.clientY) : null;
              const otherLane = toLane && toLane !== trackId ? toLane : null;
              if (Math.abs(drag.dx) < 3 && !otherLane) return;
              const dUs = Math.round((drag.dx / pps) * S);
              if (drag.mode === "out") {
                // Longer or shorter at the end: a picture just shows longer; a video uses more or less of its file.
                void editor.run("Change clip length", [{ op: "clip.trim", clipId: id, sourceOutUs: c.sourceOutUs + Math.round(dUs * (span.still ? 1 : c.speed)) }]);
              } else if (drag.mode === "in") {
                // The front edge moves and the end stays put.
                const startUs = Math.max(0, span.start + dUs);
                const moved = startUs - span.start;
                const ops: Op[] = span.still
                  ? [{ op: "clip.trim", clipId: id, sourceOutUs: c.sourceOutUs - moved }]
                  : [{ op: "clip.trim", clipId: id, sourceInUs: Math.max(0, c.sourceInUs + Math.round(moved * c.speed)) }];
                void editor.run("Change clip length", [...ops, { op: "clip.move", clipId: id, startUs }]);
              } else {
                const to = Math.max(0, Math.round(span.start + dUs));
                void editor.run(otherLane ? "Move clip to another lane" : "Move clip", [{ op: "clip.move", clipId: id, startUs: to, ...(otherLane ? { trackId: otherLane } : {}) }]);
              }
            }}
          >
            {c.link && <span className="link-pin" aria-label="Locked to the video"><Icon name="link" size={12} /></span>}
            {media ? baseName(media.path) : id}
            <b className="edge in" data-edge="in" />
            <b className="edge out" data-edge="out" />
          </div>
        );
      })}
    </div>
  );
}

/** Text and HyperFrames overlays. Click to select; drag to move in time. */
function OverlayLane({ editor, pps, onSnap }: { editor: Editor; pps: number; onSnap: (us: number | null) => void }) {
  const [drag, setDrag] = useState<{ id: string; x: number; dx: number; mode: EdgeMode } | null>(null);
  // Overlapping overlays go on separate rows so each can be clicked.
  const rowOf = new Map<string, number>();
  const ends: number[] = [];
  for (const o of editor.plan.overlays) {
    let r = ends.findIndex((e) => e <= o.tlStartUs);
    if (r < 0) r = ends.length;
    ends[r] = o.tlEndUs;
    rowOf.set(o.id, r);
  }
  const rows = Math.max(1, ends.length);
  return (
    <div className="lane overlay-lane" aria-label="Overlays" style={{ height: 22 * rows + 2 }}>
      <span className="lane-name">Overlay</span>
      {editor.plan.overlays.map((o) => {
        const dx = drag?.id === o.id ? drag.dx : 0;
        const mode = drag?.id === o.id ? drag.mode : "move";
        const row = rowOf.get(o.id) ?? 0;
        return (
          <div
            key={o.id}
            data-overlay={o.id}
            className={"overlay-block " + o.kind + (o.id === editor.selectedOverlayId ? " selected" : "")}
            style={{ top: 2 + row * 22, ...edgeStyle(PAD + (o.tlStartUs / S) * pps, ((o.tlEndUs - o.tlStartUs) / S) * pps, dx, mode) }}
            title={`${o.kind === "text" ? "Text" : "Graphic"}: ${o.text}. Drag to move, drag an edge to show it for longer or shorter.`}
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              setDrag({ id: o.id, x: e.clientX, dx: 0, mode: edgeOf(e) });
              editor.selectClip(null);
              editor.selectZoom(null);
              editor.selectOverlay(o.id);
            }}
            onPointerMove={(e) => {
              if (drag?.id !== o.id) return;
              const raw = e.clientX - drag.x;
              if (drag.mode !== "move") {
                const r = edgeDrag(editor, o.tlStartUs, o.tlEndUs, drag.mode, raw, pps, o.id, e.altKey, null);
                setDrag({ ...drag, dx: r.dx });
                onSnap(Math.abs(raw) > 3 ? r.lineUs : null);
                return;
              }
              const sn = snapMove(editor, o.tlStartUs + (raw / pps) * S, o.tlEndUs - o.tlStartUs, pps, o.id, e.altKey);
              setDrag({ ...drag, dx: Math.abs(raw) < 3 ? raw : ((sn.us - o.tlStartUs) / S) * pps });
              onSnap(Math.abs(raw) > 3 ? sn.lineUs : null);
            }}
            onPointerCancel={() => { onSnap(null); if (drag?.id === o.id) setDrag(null); }}
            onLostPointerCapture={() => { if (drag?.id === o.id) { onSnap(null); setDrag(null); } }}
            onPointerUp={(e) => {
              e.stopPropagation();
              onSnap(null);
              if (drag?.id !== o.id) return;
              setDrag(null);
              if (Math.abs(drag.dx) < 3) {
                if (drag.mode !== "move") return;
                editor.player.pause();
                // Just past its fade-in, so what was clicked is on screen.
                editor.player.seek(o.tlStartUs + Math.min(o.fadeInUs + 50_000, (o.tlEndUs - o.tlStartUs) / 2));
                return;
              }
              const dUs = Math.round((drag.dx / pps) * S);
              const what = o.kind === "text" ? "text" : "graphic";
              if (drag.mode === "out") void editor.run(`Change ${what} length`, [{ op: "overlay.set", overlayId: o.id, durationUs: o.tlEndUs - o.tlStartUs + dUs }]);
              else if (drag.mode === "in") {
                const startUs = Math.max(0, o.tlStartUs + dUs);
                void editor.run(`Change ${what} length`, [{ op: "overlay.set", overlayId: o.id, startUs, durationUs: o.tlEndUs - startUs }]);
              } else void editor.run(`Move ${what}`, [{ op: "overlay.set", overlayId: o.id, startUs: Math.max(0, o.tlStartUs + dUs) }]);
            }}
          >
            {o.kind === "hyperframes" && !editor.renderedOverlays[o.id] ? "⏳ " : ""}{o.kind === "hyperframes" ? o.params?.title || o.params?.text || o.template : o.text}
            <b className="edge in" data-edge="in" />
            <b className="edge out" data-edge="out" />
          </div>
        );
      })}
    </div>
  );
}

function Playhead({ editor, pps }: { editor: Editor; pps: number }) {
  const tl = useSyncExternalStore(editor.player.subscribe, editor.player.getTime);
  return <div className="playhead" style={{ left: PAD + (tl / S) * pps }} />;
}

/**
 * Pictures and sound outline of the main track, drawn only for the part of the
 * timeline that is on screen. Each pixel column is mapped through the cuts to
 * its moment in the take, so what is drawn is what plays.
 */
/**
 * The filmstrip and waveform under the main track. It redraws when what it shows changes (the edit,
 * the zoom, newly loaded pictures or sound, a scroll or resize), not whenever the timeline re-renders.
 */
const TrackCanvas = memo(function TrackCanvas({ plan, pid, prepared, pps, scroller }: { plan: Plan; pid: string; prepared: PreparedMap; pps: number; scroller: React.RefObject<HTMLDivElement> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [loaded, bump] = useState(0);
  const redraw = useCallback(() => bump((n) => n + 1), []);
  const drawRef = useRef<() => void>(() => {});

  // The drawing itself, always with the latest edit and zoom.
  useEffect(() => {
    const el = scroller.current;
    const c = canvas.current;
    if (!el || !c) return;
    drawRef.current = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(TRACK_H * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(TRACK_H * dpr);
        c.style.width = `${w}px`;
      }
      c.style.transform = `translateX(${el.scrollLeft}px)`;
      const g = c.getContext("2d")!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, TRACK_H);
      const x0 = el.scrollLeft - PAD;
      for (const seg of planIndex(plan).main) {
        const sx = (seg.tlStartUs / S) * pps - x0;
        const ex = (seg.tlEndUs / S) * pps - x0;
        if (ex < 0 || sx > w) continue;
        const from = Math.max(0, Math.floor(sx));
        const to = Math.min(w, Math.ceil(ex));
        const srcAt = (x: number) => seg.srcInUs + ((x + x0) / pps) * S * seg.speed - seg.tlStartUs * seg.speed;
        const info = prepared[seg.mediaId];
        // Pictures: one tile per slot, chosen by the moment at the slot's start.
        const sheet = info?.thumbs ? getSheet(pid, seg.mediaId, redraw) : null;
        if (sheet && info?.thumbs) {
          const t = info.thumbs;
          const tileW = (THUMB_H * t.w) / t.h;
          const first = Math.floor((sx < 0 ? -sx : 0) / tileW);
          for (let k = first; sx + k * tileW < to; k++) {
            const x = sx + k * tileW;
            const idx = Math.max(0, Math.min(t.count - 1, Math.floor(srcAt(Math.max(x, sx)) / t.intervalUs)));
            const cw = Math.min(tileW, ex - x);
            g.drawImage(sheet, (idx % t.cols) * t.w, Math.floor(idx / t.cols) * t.h, (t.w * cw) / tileW, t.h, x, 0, cw, THUMB_H);
          }
          g.fillStyle = "rgba(21, 23, 26, 0.35)";
          g.fillRect(from, 0, to - from, THUMB_H);
        }
        // Sound: the loudest level in each pixel column.
        const wave = info?.wave ? getWave(pid, seg.mediaId, redraw) : null;
        if (wave && seg.hasAudio) {
          g.fillStyle = seg.muted ? "#5e5a54" : "#e9c27a";
          const base = TRACK_H - 1;
          const room = TRACK_H - THUMB_H - 3;
          const perUs = 100 / S;
          for (let x = from; x < to; x++) {
            const a = Math.max(0, Math.floor(srcAt(x) * perUs));
            const b = Math.min(wave.length, Math.max(a + 1, Math.ceil(srcAt(x + 1) * perUs)));
            let peak = 0;
            for (let i = a; i < b; i++) if (wave[i]! > peak) peak = wave[i]!;
            const h = Math.max(1, (peak / 255) * room);
            g.fillRect(x, base - h, 1, h);
          }
        }
      }
    };
    drawRef.current();
  }, [plan, pid, prepared, pps, scroller, redraw, loaded]);

  // Scroll and resize listeners are set up once; several scroll events in one frame draw once.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const soon = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        drawRef.current();
      });
    };
    el.addEventListener("scroll", soon, { passive: true });
    const ro = new ResizeObserver(soon);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", soon);
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [scroller]);

  return <canvas ref={canvas} className="track-canvas" height={TRACK_H} />;
});

type Drag =
  | { kind: "scrub" }
  | { kind: "range"; fromUs: number }
  | { kind: "trim"; clipId: string; edge: "in" | "out"; startX: number; x: number }
  | { kind: "clip"; clipId: string; startX: number; x: number; moved: boolean; startUs: number; lengthUs: number; toUs: number }
  | { kind: "zoom"; zoomId: string; part: "in" | "out" | "body"; startX: number; x: number; moved: boolean; snapUs?: number };

/** The tab being dragged, kept here because a drop target cannot read drag data until the drop. */
let draggedTimeline: string | null = null;

/** One tab per timeline. Click to open one, drag one onto the timeline below to drop all of it in. */
/** Frame shapes offered for a timeline; the first is the default for new ones. */
export const FRAME_SHAPES = [
  { label: "16:9", hint: "Landscape (YouTube)", width: 1920, height: 1080 },
  { label: "9:16", hint: "Vertical (Shorts, Reels, TikTok)", width: 1080, height: 1920 },
  { label: "1:1", hint: "Square", width: 1080, height: 1080 },
  { label: "4:5", hint: "Portrait (Instagram feed)", width: 1080, height: 1350 },
] as const;

/** "9:16" for a frame of that shape, or the plain size when it is none of the offered ones. */
export function shapeLabel(width: number, height: number): string {
  const s = FRAME_SHAPES.find((f) => Math.abs(f.width / f.height - width / height) < 0.005);
  return s ? s.label : `${width}×${height}`;
}

function FrameShape({ editor }: { editor: Editor }) {
  const { width, height, frameFit } = editor.project.settings;
  const current = FRAME_SHAPES.find((f) => f.width === width && f.height === height);
  return (
    <span className="tl-shape" title="This timeline's frame shape. Each timeline has its own, so a Short can sit next to the full video.">
      <select
        aria-label="Frame shape"
        value={current ? current.label : "custom"}
        onChange={(e) => {
          const f = FRAME_SHAPES.find((x) => x.label === e.target.value);
          if (f) void editor.run(`Frame ${f.label}`, [{ op: "timeline.size", width: f.width, height: f.height }]);
        }}
      >
        {FRAME_SHAPES.map((f) => (
          <option key={f.label} value={f.label}>{f.label} · {f.hint}</option>
        ))}
        {!current && <option value="custom">{width}×{height}</option>}
      </select>
      <button
        className={"ghost tl-fit" + ((frameFit ?? "fit") === "fill" ? " on" : "")}
        onClick={() => void editor.run((frameFit ?? "fit") === "fill" ? "Show whole recording" : "Fill the frame", [{ op: "timeline.size", width, height, frameFit: (frameFit ?? "fit") === "fill" ? "fit" : "fill" }])}
        title={(frameFit ?? "fit") === "fill"
          ? "Fill: a recording of a different shape covers the frame and its edges are cut off. Click to show it whole with bars instead. Move or resize it on the preview to choose what shows."
          : "Fit: a recording of a different shape shows whole, with bars. Click to make it fill the frame instead."}
      >
        {(frameFit ?? "fit") === "fill" ? "Fill" : "Fit"}
      </button>
    </span>
  );
}

function TimelineTabs({ editor }: { editor: Editor }) {
  const p = editor.project;
  const [editing, setEditing] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const names = new Map<string, string>([[p.timelineId ?? "tl1", p.timelineName ?? "Timeline 1"], ...(p.timelines ?? []).map((t) => [t.id, t.name] as [string, string])]);
  const shapes = new Map<string, string>([[p.timelineId ?? "tl1", shapeLabel(p.settings.width, p.settings.height)], ...(p.timelines ?? []).map((t) => [t.id, t.size ? shapeLabel(t.size.width, t.size.height) : shapeLabel(p.settings.width, p.settings.height)] as [string, string])]);
  const order = [...new Set([...(p.timelineOrder ?? []), ...names.keys()])].filter((id) => names.has(id));
  const rename = (id: string, name: string) => {
    setEditing(null);
    if (name.trim() && name.trim() !== names.get(id)) void editor.run("Rename timeline", [{ op: "timeline.rename", timelineId: id, name: name.trim() }]);
  };
  return (
    <div className="tl-tabs" role="tablist" aria-label="Timelines">
      {order.map((id) => {
        const active = id === p.timelineId;
        const name = names.get(id)!;
        return (
          <div
            key={id} role="tab" aria-selected={active} className={"tl-tab" + (active ? " active" : "")}
            draggable={!active && editing !== id}
            onDragStart={(e) => {
              draggedTimeline = id;
              e.dataTransfer.setData("text/plain", name);
              e.dataTransfer.effectAllowed = "copy";
            }}
            onDragEnd={() => (draggedTimeline = null)}
            onClick={() => !active && editing !== id && void editor.run(`Open ${name}`, [{ op: "timeline.switch", timelineId: id }])}
            onDoubleClick={() => setEditing(id)}
            title={active ? "Double-click to rename" : "Click to open. Drag onto the timeline below to drop all of it in. Double-click to rename."}
          >
            {editing === id ? (
              <input
                autoFocus defaultValue={name} onClick={(e) => e.stopPropagation()}
                onBlur={(e) => rename(id, e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") rename(id, (e.target as HTMLInputElement).value);
                  if (e.key === "Escape") setEditing(null);
                }}
              />
            ) : (
              <span>{name}</span>
            )}
            {editing !== id && shapes.get(id) !== "16:9" && <em className="tl-tab-shape">{shapes.get(id)}</em>}
            {order.length > 1 && editing !== id && (
              <button
                className="x" aria-label={`Remove ${name}`}
                onBlur={() => setAsking(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  if (asking === id) {
                    setAsking(null);
                    void editor.run(`Remove ${name}`, [{ op: "timeline.remove", timelineId: id }]);
                  } else setAsking(id);
                }}
              >
                {asking === id ? "Remove?" : "×"}
              </button>
            )}
          </div>
        );
      })}
      <button className="ghost" onClick={() => void editor.run("New timeline", [{ op: "timeline.add" }])} title="Start another timeline in this project, for building a section on its own">+ Timeline</button>
      <FrameShape editor={editor} />
    </div>
  );
}

export function Timeline({ editor }: { editor: Editor }) {
  const { plan, project, player, selectedClipId, selectedZoomId, range } = editor;
  const [pps, setPps] = useState(() => Number(local.get("sous.pps")) || 40);
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [guideX, setGuideX] = useState<number | null>(null);
  const [zoomDrag, setZoomDrag] = useState<{ id: string; part: string; dx: number } | null>(null);
  const [clipDrag, setClipDrag] = useState<{ id: string; dx: number } | null>(null);
  /** Where the snapping guide line is, in timeline time. */
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const [dropLine, setDropLine] = useState<number | null>(null);
  const [dropLane, setDropLane] = useState<string | null>(null);
  const spans = clipSpans(plan);
  // Empty stretches of the main track.
  const gaps: { startUs: number; endUs: number }[] = [];
  {
    let end = 0;
    for (const sp of [...spans.values()].sort((a, b) => a.startUs - b.startUs)) {
      if (sp.startUs - end > 1000) gaps.push({ startUs: end, endUs: sp.startUs });
      end = Math.max(end, sp.endUs);
    }
  }
  const durationS = plan.durationUs / S;
  // Lanes show only when something is in them or Hermes suggests something for them: by default the timeline is just the main track.
  const showZoomLane = plan.camera.length > 0 || editor.proposals.some((p) => p.items.some((i) => i.kind === "zoom" && !editor.skipped.has(i.id)));
  // Room past the end, so a clip can be dragged out there.
  const width = Math.max((durationS + 30) * pps + PAD * 2, 300);

  useEffect(() => {
    local.set("sous.pps", String(pps));
  }, [pps]);

  // Keep the playhead in view while playing.
  useEffect(() => {
    return player.subscribe(() => {
      const el = scroller.current;
      if (!el || !player.playing) return;
      const x = PAD + (player.tlUs / S) * pps;
      if (x > el.scrollLeft + el.clientWidth - 40 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 80);
    });
  }, [player, pps]);

  const usAt = (clientX: number): number => {
    const el = scroller.current!;
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft - PAD;
    return Math.max(0, Math.min(plan.durationUs, Math.round((x / pps) * S)));
  };

  /** Where a dropped timeline would go: between clips, never inside one. */
  /** Where dragged media lands: under the pointer, pulled onto a nearby cut or clip edge. */
  const mediaDropUs = (clientX: number): number => {
    const el = scroller.current!;
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft - PAD;
    let us = Math.max(0, Math.round((x / pps) * S));
    let best = 8;
    const edges = [0, plan.durationUs, ...plan.segments.flatMap((s) => [s.tlStartUs, s.tlEndUs]), ...plan.overlays.flatMap((o) => [o.tlStartUs, o.tlEndUs])];
    const raw = us;
    for (const t of edges) {
      const d = Math.abs(((t - raw) / S) * pps);
      if (d < best) {
        best = d;
        us = t;
      }
    }
    return us;
  };
  const dropUs = (clientX: number): number => {
    const el = scroller.current!;
    let us = Math.max(0, Math.round(((clientX - el.getBoundingClientRect().left + el.scrollLeft - PAD) / pps) * S));
    for (const sp of spans.values()) if (us > sp.startUs && us < sp.endUs) us = us - sp.startUs < sp.endUs - us ? sp.startUs : sp.endUs;
    return Math.min(us, Math.max(plan.durationUs, 0));
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const zoomEl = target.closest<HTMLElement>("[data-zoom]");
    if (zoomEl) {
      const id = zoomEl.dataset.zoom!;
      const part = (target.closest<HTMLElement>("[data-zoom-edge]")?.dataset.zoomEdge ?? "body") as "in" | "out" | "body";
      drag.current = { kind: "zoom", zoomId: id, part, startX: e.clientX, x: e.clientX, moved: false };
      editor.selectClip(null);
      editor.selectZoom(id);
      return;
    }
    const handle = target.closest<HTMLElement>("[data-trim]");
    if (handle) {
      drag.current = { kind: "trim", clipId: handle.dataset.clip!, edge: handle.dataset.trim as "in" | "out", startX: e.clientX, x: e.clientX };
      editor.selectClip(handle.dataset.clip!);
      setGuideX(e.clientX);
      return;
    }
    const us = usAt(e.clientX);
    if (e.shiftKey) {
      drag.current = { kind: "range", fromUs: us };
      editor.setRange([us, us]);
      return;
    }
    const clipEl = target.closest<HTMLElement>("[data-clip-block]");
    editor.selectZoom(null);
    editor.selectOverlay(null);
    editor.selectClip(clipEl ? clipEl.dataset.clipBlock! : null);
    if (range) editor.setRange(null);
    player.pause();
    player.seek(us);
    const span = clipEl ? spans.get(clipEl.dataset.clipBlock!) : undefined;
    // Press on a clip and drag to move it; a plain click just puts the playhead there.
    drag.current = clipEl && span
      ? { kind: "clip", clipId: clipEl.dataset.clipBlock!, startX: e.clientX, x: e.clientX, moved: false, startUs: span.startUs, lengthUs: span.endUs - span.startUs, toUs: span.startUs }
      : { kind: "scrub" };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "scrub") player.seek(usAt(e.clientX));
    else if (d.kind === "range") editor.setRange([d.fromUs, usAt(e.clientX)]);
    else if (d.kind === "trim") {
      d.x = e.clientX;
      setGuideX(e.clientX);
    } else if (d.kind === "clip") {
      d.x = e.clientX;
      if (Math.abs(d.x - d.startX) > 4) d.moved = true;
      if (!d.moved) return;
      const sn = snapMove(editor, d.startUs + ((d.x - d.startX) / pps) * S, d.lengthUs, pps, d.clipId, e.altKey, true);
      d.toUs = sn.us;
      setClipDrag({ id: d.clipId, dx: ((sn.us - d.startUs) / S) * pps });
      setSnapLine(sn.lineUs);
    } else {
      d.x = e.clientX;
      if (Math.abs(d.x - d.startX) > 3) d.moved = true;
      if (!d.moved) return;
      // Snap whichever edges are moving to the nearest cut.
      const span = plan.camera.find((c) => c.zoomId === d.zoomId);
      const rawUs = ((d.x - d.startX) / pps) * S;
      const edges = span ? [...(d.part !== "out" ? [span.tlStartUs + rawUs] : []), ...(d.part !== "in" ? [span.tlEndUs + rawUs] : [])] : [];
      const sn = snapEdges(editor, edges, pps, d.zoomId, e.altKey);
      d.snapUs = sn.deltaUs;
      setSnapLine(sn.lineUs);
      setZoomDrag({ id: d.zoomId, part: d.part, dx: d.x - d.startX + (sn.deltaUs / S) * pps });
    }
  };

  // A gesture the system takes away (touch cancelled, pointer lost) ends without saving anything.
  const onCancel = () => {
    drag.current = null;
    setGuideX(null);
    setZoomDrag(null);
    setClipDrag(null);
    setSnapLine(null);
  };
  const onUp = () => {
    const d = drag.current;
    onCancel();
    if (!d) return;
    if (d.kind === "clip") {
      if (d.moved && d.toUs !== d.startUs) void editor.run("Move clip", [{ op: "clip.move", clipId: d.clipId, startUs: d.toUs }]);
      return;
    }
    if (d.kind === "range" && range && Math.abs(range[1] - range[0]) < 50_000) editor.setRange(null);
    if (d.kind === "trim") {
      const clip = project.items[d.clipId];
      if (!clip || clip.type !== "clip") return;
      const deltaUs = Math.round((((d.x - d.startX) / pps) * S * clip.speed) / 1000) * 1000;
      if (Math.abs(deltaUs) < 20_000) return;
      const media = project.media.find((m) => m.id === clip.mediaId);
      const limit = media?.durationUs ?? clip.sourceOutUs;
      if (d.edge === "in") {
        const sourceInUs = Math.max(0, Math.min(clip.sourceOutUs - 100_000, clip.sourceInUs + deltaUs));
        void editor.run("Trim clip start", [{ op: "clip.trim", clipId: clip.id, sourceInUs }]);
      } else {
        const sourceOutUs = Math.min(limit, Math.max(clip.sourceInUs + 100_000, clip.sourceOutUs + deltaUs));
        void editor.run("Trim clip end", [{ op: "clip.trim", clipId: clip.id, sourceOutUs }]);
      }
    }
    if (d.kind === "zoom") {
      const zoom = project.items[d.zoomId] as Zoom | undefined;
      const span = plan.camera.find((c) => c.zoomId === d.zoomId);
      if (!zoom || zoom.type !== "zoom" || !span) return;
      if (!d.moved) {
        // A plain click: go to the moment the zoom is fully in.
        player.pause();
        player.seek(span.tlStartUs);
        return;
      }
      const deltaUs = Math.round(((d.x - d.startX) / pps) * S + (d.snapUs ?? 0));
      // Zooms live in the take's own time. Move the edges on the timeline, then map back.
      let tlStart = span.tlStartUs + (d.part === "out" ? 0 : deltaUs);
      let tlEnd = span.tlEndUs + (d.part === "in" ? 0 : deltaUs);
      tlStart = Math.max(0, Math.min(tlStart, plan.durationUs - 200_000));
      tlEnd = Math.max(tlStart + 200_000, Math.min(tlEnd, plan.durationUs - 1));
      const a = timelineToSource(plan, tlStart);
      const b = timelineToSource(plan, tlEnd);
      if (!a || !b || a.segment.mediaId !== zoom.mediaId || b.segment.mediaId !== zoom.mediaId || b.srcUs <= a.srcUs) {
        editor.notify("A zoom has to stay inside one take.", "error");
        return;
      }
      void editor.run(d.part === "body" ? "Move zoom" : "Resize zoom", [{ op: "zoom.set", zoomId: zoom.id, startUs: Math.round(a.srcUs), endUs: Math.round(b.srcUs) }]);
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.altKey) return;
    setPps((p) => Math.max(MIN_PPS, Math.min(MAX_PPS, p * (e.deltaY < 0 ? 1.2 : 1 / 1.2))));
  };

  const addZoom = () => {
    const hit = timelineToSource(plan, player.tlUs);
    if (!hit) {
      editor.notify("Move the playhead onto a clip first.");
      return;
    }
    const media = project.media.find((m) => m.id === hit.segment.mediaId);
    const startUs = Math.round(hit.srcUs);
    const endUs = Math.min(media?.durationUs ?? startUs + 4 * S, startUs + 4 * S);
    void editor.run(`Add zoom at ${clock(player.tlUs)}`, [{ op: "zoom.add", mediaId: hit.segment.mediaId, startUs, endUs, rect: [0.3, 0.3, 0.4, 0.4] }]).then((created) => {
      const id = created?.[0];
      if (id) {
        editor.selectClip(null);
        editor.selectZoom(id);
      }
    });
  };

  const addText = () =>
    void editor.run(`Add text at ${clock(player.tlUs)}`, [{ op: "overlay.add", kind: "text", startUs: Math.round(player.tlUs), durationUs: 4 * S, text: "New text", transform: { y: -0.3 } }]).then((created) => {
      const id = created?.[0];
      if (id) {
        editor.selectClip(null);
        editor.selectZoom(null);
        editor.selectOverlay(id);
      }
    });

  const [templates, setTemplates] = useState<Record<string, { description: string; defaults: Record<string, string> }>>({});
  useEffect(() => {
    void api.templates(editor.pid).then((r) => setTemplates(r.templates)).catch(() => undefined);
  }, [editor.pid]);

  const [naming, setNaming] = useState<string | null>(null);
  // From the toolbar the new marker asks for a name straight away; the M key just drops one.
  const addMarker = () => void editor.run(`Add marker at ${clock(player.tlUs)}`, [{ op: "marker.add", timeUs: Math.round(player.tlUs) }]).then((ids) => { if (ids?.[0]) setNaming(ids[0]); });

  const step = tickStep(pps);
  const ticks: number[] = [];
  for (let t = 0; t <= durationS + step; t += step) ticks.push(t);
  const guide = guideX !== null && scroller.current ? guideX - scroller.current.getBoundingClientRect().left + scroller.current.scrollLeft : null;

  return (
    <section className="timeline" aria-label="Timeline">
      <TimelineTabs editor={editor} />
      <div className="timeline-tools">
        <input
          type="range" min={Math.log(MIN_PPS)} max={Math.log(MAX_PPS)} step="0.01" value={Math.log(pps)}
          onChange={(e) => setPps(Math.exp(Number(e.target.value)))} aria-label="Timeline zoom" title="Zoom the timeline in and out (Ctrl+scroll)"
        />
        <button
          className="ghost icon-only" title="Fit the whole timeline in view" aria-label="Fit"
          onClick={() => {
            const w = (scroller.current?.clientWidth ?? 800) - PAD * 2;
            if (durationS > 0) setPps(Math.max(MIN_PPS, Math.min(MAX_PPS, w / durationS)));
          }}
        >
          <Icon name="fit" />
        </button>
        <span className="sep" />
        <span className="add-group" role="group" aria-label="Add at the playhead">
          <span className="add-plus" aria-hidden="true"><Icon name="plus" size={14} /></span>
          <button className="tool" onClick={addZoom} disabled={plan.durationUs === 0} title="Add a smooth zoom at the playhead (Z)"><Icon name="zoom" /><span>Zoom</span></button>
          <button className="tool" onClick={addMarker} title="Drop a marker at the playhead (M)"><Icon name="marker" /><span>Marker</span></button>
          <button className="tool" onClick={addText} title="Put a line of text over the picture at the playhead (T)"><Icon name="text" /><span>Text</span></button>
          <GraphicMenu templates={templates} onPick={(name) => {
            const t = templates[name];
            void editor.run(`Add ${name} at ${clock(player.tlUs)}`, [{ op: "overlay.add", kind: "hyperframes", template: name, startUs: Math.round(player.tlUs), durationUs: (GRAPHIC_SECONDS[name] ?? 4) * S, text: name, params: { ...(t?.defaults ?? {}) } }]).then((created) => {
              const id = created?.[0];
              if (id) {
                editor.selectClip(null);
                editor.selectZoom(null);
                editor.selectOverlay(id);
              }
            });
          }} />
        </span>
        <TransitionMenu editor={editor} />
        <button
          className="tool" onClick={() => void editor.autoZoom()} disabled={plan.durationUs === 0 || editor.jobs.some((j) => j.kind === "roughcut")}
          title="Find where you point with the mouse and where the screen changes, and suggest zooms there. Nothing changes until you accept."
        >
          <Icon name="zoom" /><span>Auto zoom</span>
        </button>
        <span className="sep" />
        <button className="with-icon" onClick={() => void editor.run("Close all gaps", [{ op: "gap.close" }])} disabled={gaps.length === 0} title="Slide every clip left so there is no empty space on the main track"><Icon name="gaps" />Close gaps</button>
        <span className="hint">Drag a clip to move it; it snaps to cuts (Alt: no snap). Shift-drag marks a range. Drag an edge to trim.</span>
      </div>
      <div className="timeline-scroll" ref={scroller} onWheel={onWheel}>
        <div className="timeline-canvas" data-drop-lane={dropLane ?? undefined} style={{ width }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel}
          onDragOver={(e) => {
            if (draggedMedia) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              setDropLine(mediaDropUs(e.clientX));
              setDropLane((e.target as HTMLElement).closest<HTMLElement>("[data-track]")?.dataset.track ?? null);
              return;
            }
            if (!draggedTimeline) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setDropLine(dropUs(e.clientX));
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node)) return;
            setDropLine(null);
            setDropLane(null);
          }}
          onDrop={(e) => {
            const m = draggedMedia;
            if (m) {
              e.preventDefault();
              const lane = (e.target as HTMLElement).closest<HTMLElement>("[data-track]")?.dataset.track;
              setDropLine(null);
              setDropLane(null);
              void placeMedia(editor, m, mediaDropUs(e.clientX), lane);
              return;
            }
            const id = draggedTimeline;
            draggedTimeline = null;
            setDropLine(null);
            if (!id) return;
            e.preventDefault();
            const name = (project.timelines ?? []).find((t) => t.id === id)?.name ?? "timeline";
            void editor.run(`Drop ${name} in at ${clock(dropUs(e.clientX))}`, [{ op: "timeline.insert", timelineId: id, atUs: dropUs(e.clientX) }]);
          }}
        >
          <div className="ruler">
            {ticks.map((t) => (
              <span key={t} className="tick" style={{ left: PAD + t * pps }}>{clock(t * S, 0)}</span>
            ))}
            {project.markers.map((m) => (
              <span key={m.id} className="marker-wrap" style={{ left: PAD + (m.timeUs / S) * pps }}>
                <button
                  className={"marker" + (m.label ? " named" : "")} aria-label={`${m.label || "Marker"} at ${clock(m.timeUs)}`}
                  title={`${m.label || "Unnamed marker"} at ${clock(m.timeUs)}. Double-click to name it; named markers become chapters.`}
                  onPointerDown={(e) => { e.stopPropagation(); player.pause(); player.seek(m.timeUs); }}
                  onDoubleClick={(e) => { e.stopPropagation(); setNaming(m.id); }}
                />
                {m.label && <span className="marker-label" onPointerDown={(e) => { e.stopPropagation(); player.pause(); player.seek(m.timeUs); }} onDoubleClick={() => setNaming(m.id)}>{m.label}</span>}
                {naming === m.id && <MarkerEditor editor={editor} marker={m} onDone={() => setNaming(null)} />}
              </span>
            ))}
          </div>
          {showZoomLane && <div className="lane zoom-lane" aria-label="Zooms">
            <span className="lane-name">Zoom</span>
            {editor.proposals.flatMap((p) =>
              p.items.filter((i) => i.kind === "zoom" && !editor.skipped.has(i.id)).flatMap((i) =>
                i.ops.flatMap((op) => {
                  if (op.op !== "zoom.add") return [];
                  const a = sourceToTimeline(plan, op.mediaId, op.startUs);
                  const b = sourceToTimeline(plan, op.mediaId, op.endUs - 1000);
                  if (a === null || b === null) return [];
                  return [<div key={i.id} className="zoom-block ghost" style={{ left: PAD + (a / S) * pps, width: Math.max(6, ((b - a) / S) * pps) }} title={`Suggested: ${i.label}`} />];
                }),
              ),
            )}
            {plan.camera.map((c) => {
              const moving = zoomDrag?.id === c.zoomId ? zoomDrag : null;
              let left = PAD + (c.tlStartUs / S) * pps;
              let w = ((c.tlEndUs - c.tlStartUs) / S) * pps;
              if (moving) {
                if (moving.part !== "out") left += moving.dx;
                if (moving.part === "in") w -= moving.dx;
                if (moving.part === "out") w += moving.dx;
              }
              const lead = (c.inUs / S) * pps;
              const tail = (c.outUs / S) * pps;
              return (
                <div key={c.zoomId} data-zoom={c.zoomId} className={"zoom-block" + (c.zoomId === selectedZoomId ? " selected" : "")} style={{ left, width: Math.max(w, 6) }} title="Zoom. Drag to move, drag an edge to resize.">
                  <i className="ramp in" style={{ width: lead, left: -lead }} />
                  <i className="ramp out" style={{ width: tail, right: -tail }} />
                  <b data-zoom-edge="in" className="edge in" />
                  <b data-zoom-edge="out" className="edge out" />
                </div>
              );
            })}
          </div>}
          {plan.overlays.length > 0 && <OverlayLane editor={editor} pps={pps} onSnap={setSnapLine} />}
          {project.tracks.filter((t) => t.kind === "video" && t.items.length > 0).map((t) => <TrackLane key={t.id} editor={editor} pps={pps} trackId={t.id} onSnap={setSnapLine} />)}
          <div className={"track main-track" + (dropLane === "main" ? " drop-target" : "")} data-track="main" style={{ height: TRACK_H }}>
            <TrackCanvas plan={plan} pid={editor.pid} prepared={editor.prepared} pps={pps} scroller={scroller} />
            {editor.clips.map((clip) => {
              const span = spans.get(clip.id);
              if (!span) return null;
              const media = project.media.find((m) => m.id === clip.mediaId);
              const moving = clipDrag?.id === clip.id ? clipDrag.dx : 0;
              const left = PAD + (span.startUs / S) * pps + moving;
              const w = ((span.endUs - span.startUs) / S) * pps;
              return (
                <div
                  key={clip.id}
                  data-clip-block={clip.id}
                  className={"clip" + (clip.id === selectedClipId ? " selected" : "") + (moving ? " moving" : "")}
                  style={{ left, width: Math.max(w, 2), "--clip-hue": mediaHue(project.media.findIndex((m) => m.id === clip.mediaId)) } as CSSProperties}
                  title={media ? baseName(media.path) : clip.id}
                >
                  <span className="clip-name">{media ? baseName(media.path) : clip.id}</span>
                  {span.cuts.map((c) => (
                    <i key={c} className="cut-mark" style={{ left: ((c - span.startUs) / S) * pps }} title="Cut" />
                  ))}
                  <b className="trim in" data-trim="in" data-clip={clip.id} />
                  <b className="trim out" data-trim="out" data-clip={clip.id} />
                </div>
              );
            })}
            {gaps.map((g) => (
              <div
                key={g.startUs} className="gap" style={{ left: PAD + (g.startUs / S) * pps, width: ((g.endUs - g.startUs) / S) * pps }}
                title={`Empty space, ${clock(g.endUs - g.startUs, 1)}. It plays as black.`}
              >
                <button onPointerDown={(e) => e.stopPropagation()} onClick={() => void editor.run("Close gap", [{ op: "gap.close", atUs: g.startUs }])}>Close gap</button>
              </div>
            ))}
            {editor.clips.length === 0 && <p className="track-empty">Drag a take here from the media list, or start with text or a graphic.</p>}
            <TransitionKnobs editor={editor} pps={pps} />
          </div>
          {project.tracks.filter((t) => t.kind === "audio" && t.items.length > 0).map((t) => <TrackLane key={t.id} editor={editor} pps={pps} trackId={t.id} onSnap={setSnapLine} />)}
          {range && (
            <div
              className="range"
              style={{ left: PAD + (Math.min(range[0], range[1]) / S) * pps, width: (Math.abs(range[1] - range[0]) / S) * pps }}
            />
          )}
          {guide !== null && <div className="trim-guide" style={{ left: guide }} />}
          {snapLine !== null && <div className="snap-line" style={{ left: PAD + (snapLine / S) * pps }} />}
          {dropLine !== null && <div className="snap-line drop" style={{ left: PAD + (dropLine / S) * pps }} />}
          <Playhead editor={editor} pps={pps} />
        </div>
      </div>
    </section>
  );
}

/** Where a zoom sits on the timeline, or null when its content is cut out. */
export function zoomTimeline(plan: Plan, zoom: Zoom): number | null {
  return sourceToTimeline(plan, zoom.mediaId, zoom.startUs);
}

/** The graphics that can be dropped at the playhead, as a small menu under a button. */
function GraphicMenu({ templates, onPick }: { templates: Record<string, { description: string }>; onPick: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("pointerdown", away); window.removeEventListener("keydown", esc); };
  }, [open]);
  const names = Object.keys(templates);
  return (
    <span className="menu-wrap" ref={box}>
      <button className="tool" aria-haspopup="menu" aria-expanded={open} disabled={names.length === 0} onClick={() => setOpen((o) => !o)} title="Add a HyperFrames graphic at the playhead">
        <Icon name="graphic" /><span>Graphic</span><Icon name="chevron" size={12} className="caret" />
      </button>
      {open && (
        <div className="menu" role="menu">
          {names.map((name) => (
            <button key={name} role="menuitem" onClick={() => { setOpen(false); onPick(name); }}>
              <strong>{name.replace(/-/g, " ")}</strong>
              {templates[name]!.description && <span>{templates[name]!.description}</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/**
 * A colour per recording, so the pieces of a split take share their parent's outline. Hues step by
 * the golden angle from the media list order, which keeps neighbours far apart and never changes as
 * media are added.
 */
function mediaHue(index: number): number {
  return Math.round((205 + Math.max(0, index) * 137.508) % 360);
}

/** Names (or deletes) a marker in place. Enter saves, Escape cancels; a named marker is a chapter. */
function MarkerEditor({ editor, marker, onDone }: { editor: Editor; marker: { id: string; label: string; timeUs: number }; onDone: () => void }) {
  const [text, setText] = useState(marker.label);
  const box = useRef<HTMLDivElement>(null);
  const save = () => {
    const label = text.trim();
    if (label !== marker.label) void editor.run(label ? `Name marker "${label}"` : "Clear marker name", [{ op: "marker.update", markerId: marker.id, label }]);
    onDone();
  };
  useEffect(() => {
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) onDone(); };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [onDone]);
  return (
    <div className="marker-editor" ref={box} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <input
        autoFocus value={text} maxLength={100} placeholder="Chapter name, e.g. Intro" aria-label="Marker name"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") save(); else if (e.key === "Escape") onDone(); }}
      />
      <div className="row">
        <span className="dim small grow">at {clock(marker.timeUs)}</span>
        <button className="ghost small with-icon" onClick={() => { void editor.run("Remove marker", [{ op: "marker.remove", markerId: marker.id }]); onDone(); }}><Icon name="trash" size={14} />Delete</button>
        <button className="primary small" onClick={save}>Save</button>
      </div>
    </div>
  );
}


/** Puts a transition on the cut between clips nearest the playhead. */
function TransitionMenu({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("pointerdown", away); window.removeEventListener("keydown", esc); };
  }, [open]);
  const cuts = transitionCuts(editor);
  const pick = (kind: TransitionKind | null) => {
    setOpen(false);
    const t = editor.player.tlUs;
    const near = cuts.reduce<Cut | null>((best, c) => (!best || Math.abs(c.atUs - t) < Math.abs(best.atUs - t) ? c : best), null);
    if (near) applyTransition(editor, near, kind);
  };
  return (
    <span className="menu-wrap" ref={box}>
      <button className="tool" aria-haspopup="menu" aria-expanded={open} disabled={!cuts.length} onClick={() => setOpen(!open)} title={cuts.length ? "Put a transition on the cut nearest the playhead, or click the diamond on any cut in the timeline" : "Split a clip or put two clips side by side to make a cut"}>
        <Icon name="transition" /><span>Transition</span><Icon name="chevron" size={12} className="caret" />
      </button>
      {open && (
        <div className="menu" role="menu">
          {TRANSITION_KINDS.map((k) => <button key={k} role="menuitem" onClick={() => pick(k)}><strong>{TRANSITION_NAMES[k]}</strong><span>{TRANSITION_HINTS[k]}</span></button>)}
          <button role="menuitem" onClick={() => pick(null)}><strong>None</strong><span>A plain cut</span></button>
        </div>
      )}
    </span>
  );
}
