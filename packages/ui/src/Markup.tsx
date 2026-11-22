import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, token } from "./api";
import { attachToChat } from "./attach";
import { Icon } from "./icons";
import { describeMarks, type Pt, type Shape, type Tool } from "./marks";
import type { Editor } from "./useEditor";

/**
 * Draw on the paused frame to show Hermes what you mean: a freehand stroke, a box or a numbered point.
 * "Send to chat" puts a picture of the frame with the drawing on it into the chat, plus the exact
 * positions in words, so "zoom in here" or "put the title over this" lands on the right spot.
 */

const COLORS = ["#f9a302", "#ff4d4d", "#ffffff"] as const;
const clamp = (v: number) => Math.min(1, Math.max(0, v));

function paint(ctx: CanvasRenderingContext2D, shapes: Shape[], w: number, h: number): void {
  const lw = Math.max(2, w * 0.0045);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  let n = 0;
  for (const s of shapes) {
    n += 1;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = lw;
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = lw * 1.5;
    let label: Pt;
    if (s.kind === "draw") {
      ctx.beginPath();
      s.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)));
      ctx.stroke();
      label = s.pts[0]!;
    } else if (s.kind === "box") {
      const x = Math.min(s.a[0], s.b[0]) * w;
      const y = Math.min(s.a[1], s.b[1]) * h;
      ctx.strokeRect(x, y, Math.abs(s.b[0] - s.a[0]) * w, Math.abs(s.b[1] - s.a[1]) * h);
      label = [Math.min(s.a[0], s.b[0]), Math.min(s.a[1], s.b[1])];
    } else {
      const r = lw * 3.2;
      ctx.beginPath();
      ctx.arc(s.at[0] * w, s.at[1] * h, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(s.at[0] * w, s.at[1] * h, r * 2.4, 0, Math.PI * 2);
      ctx.stroke();
      label = s.at;
    }
    // The number Hermes reads about in the message.
    const r = lw * 4.2;
    const cx = clamp(label[0]) * w + (s.kind === "point" ? r * 2.6 : -r * 0.2);
    const cy = clamp(label[1]) * h - (s.kind === "point" ? r * 1.6 : r * 1.4);
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(Math.min(w - r, Math.max(r, cx)), Math.min(h - r, Math.max(r, cy)), r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = s.color === "#ffffff" ? "#111" : "#fff";
    ctx.font = `700 ${Math.round(r * 1.25)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(n), Math.min(w - r, Math.max(r, cx)), Math.min(h - r, Math.max(r, cy)) + r * 0.05);
  }
  ctx.shadowBlur = 0;
}

/** Where a video's picture actually sits inside its box, for object-fit contain or cover. */
function contentRect(v: HTMLVideoElement, x: number, y: number, w: number, h: number): [number, number, number, number] {
  const fit = getComputedStyle(v).objectFit;
  const vw = v.videoWidth || w;
  const vh = v.videoHeight || h;
  if (fit !== "contain" && fit !== "cover") return [x, y, w, h];
  const s = fit === "contain" ? Math.min(w / vw, h / vh) : Math.max(w / vw, h / vh);
  return [x + (w - vw * s) / 2, y + (h - vh * s) / 2, vw * s, vh * s];
}

/** The preview as it looks now (zoom, pictures, graphics), drawn into a canvas at the edit's size. */
async function snapshot(stage: HTMLElement, width: number, height: number, pid: string, atUs: number): Promise<HTMLCanvasElement> {
  const scale = Math.min(1, 1920 / Math.max(width, height));
  const W = Math.round(width * scale);
  const H = Math.round(height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  const box = stage.getBoundingClientRect();
  const k = W / box.width;
  let drew = false;
  try {
    for (const v of Array.from(stage.querySelectorAll("video"))) {
      const cs = getComputedStyle(v);
      if (v.readyState < 2 || cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
      const r = v.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const [x, y, w, h] = contentRect(v, (r.left - box.left) * k, (r.top - box.top) * k, r.width * k, r.height * k);
      ctx.save();
      ctx.globalAlpha = Number(cs.opacity) || 1;
      // A cropped picture shows only its inset part.
      const inset = /inset\(\s*([\d.]+)%\s+([\d.]+)%\s+([\d.]+)%\s+([\d.]+)%/.exec(cs.clipPath);
      if (inset) {
        const [t, rt, b, l] = inset.slice(1).map(Number) as [number, number, number, number];
        const bx = (r.left - box.left) * k;
        const by = (r.top - box.top) * k;
        ctx.beginPath();
        ctx.rect(bx + (r.width * k * l) / 100, by + (r.height * k * t) / 100, r.width * k * (1 - (l + rt) / 100), r.height * k * (1 - (t + b) / 100));
        ctx.clip();
      }
      ctx.drawImage(v, x, y, w, h);
      ctx.restore();
      drew = true;
    }
    ctx.getImageData(0, 0, 1, 1); // throws if a picture could not be read back
  } catch {
    drew = false;
  }
  if (!drew) {
    // Fall back to the main recording's frame at this moment, read by the server.
    const img = new Image();
    img.src = `/api/p/${pid}/frame?tlUs=${Math.round(atUs)}&width=${W}&token=${token}`;
    await img.decode();
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0, W, H);
  }
  return canvas;
}

export function Markup({ editor, stage, onClose }: { editor: Editor; stage: HTMLElement; onClose: () => void }) {
  const { player, plan, pid } = editor;
  const [tool, setTool] = useState<Tool>("box");
  const [color, setColor] = useState<string>(COLORS[0]);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [busy, setBusy] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const live = useRef<Shape | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const atUs = useRef(player.tlUs);

  useEffect(() => {
    player.pause();
    atUs.current = player.tlUs;
  }, [player]);

  const redraw = useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    const r = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) {
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
    }
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    paint(ctx, live.current ? [...shapes, live.current] : shapes, c.width, c.height);
  }, [shapes]);
  useLayoutEffect(redraw, [redraw]);
  useEffect(() => {
    const ro = new ResizeObserver(redraw);
    if (canvas.current) ro.observe(canvas.current);
    return () => ro.disconnect();
  }, [redraw]);

  const send = useCallback(async () => {
    if (!shapes.length || busy) return;
    setBusy(true);
    try {
      const shot = await snapshot(stage, plan.width, plan.height, pid, atUs.current);
      paint(shot.getContext("2d")!, shapes, shot.width, shot.height);
      const blob = await new Promise<Blob>((res, rej) => shot.toBlob((b) => (b ? res(b) : rej(new Error("Could not save the picture"))), "image/png"));
      const r = await api.uploadChatImage(pid, blob);
      attachToChat({ file: r.file, url: api.chatImageUrl(pid, r.file), note: describeMarks(shapes, atUs.current) });
      onClose();
    } catch (e) {
      editor.notify(e instanceof Error ? e.message : String(e), "error");
      setBusy(false);
    }
  }, [shapes, busy, stage, plan.width, plan.height, pid, editor, onClose]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "Escape") onClose();
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") setShapes((s) => s.slice(0, -1));
      else if (e.key === "Enter") void send();
      else if (!e.ctrlKey && !e.metaKey && !e.altKey && ["1", "2", "3"].includes(e.key)) setTool((["draw", "box", "point"] as const)[Number(e.key) - 1]!);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose, send]);

  const where = (e: React.PointerEvent): Pt => {
    const r = canvas.current!.getBoundingClientRect();
    return [clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height)];
  };

  return (
    <div className={"markup" + (drawing ? " drawing" : "")} onClick={(e) => e.stopPropagation()}>
      <canvas
        ref={canvas}
        className={"markup-canvas tool-" + tool}
        onPointerDown={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          const p = where(e);
          if (tool === "point") {
            setShapes((s) => [...s, { kind: "point", color, at: p }]);
            return;
          }
          live.current = tool === "box" ? { kind: "box", color, a: p, b: p } : { kind: "draw", color, pts: [p] };
          setDrawing(true);
          redraw();
        }}
        onPointerMove={(e) => {
          const s = live.current;
          if (!s) return;
          const p = where(e);
          if (s.kind === "box") s.b = p;
          else if (s.kind === "draw") s.pts.push(p);
          redraw();
        }}
        onPointerUp={() => {
          const s = live.current;
          live.current = null;
          setDrawing(false);
          if (!s) return;
          const tiny = s.kind === "box" ? Math.abs(s.b[0] - s.a[0]) < 0.01 && Math.abs(s.b[1] - s.a[1]) < 0.01 : s.kind === "draw" && s.pts.length < 3;
          if (tiny) redraw();
          else setShapes((all) => [...all, s]);
        }}
      />
      <div className="markup-bar" onPointerDown={(e) => e.stopPropagation()}>
        {([["draw", "pen", "Draw (1)"], ["box", "box", "Box (2)"], ["point", "point", "Point (3)"]] as const).map(([t, icon, label]) => (
          <button key={t} className={tool === t ? "on" : ""} onClick={() => setTool(t)} title={label} aria-label={label}><Icon name={icon} /></button>
        ))}
        <span className="markup-sep" />
        {COLORS.map((c) => (
          <button key={c} className={"swatch" + (color === c ? " on" : "")} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Colour ${c}`} />
        ))}
        <span className="markup-sep" />
        <button onClick={() => setShapes((s) => s.slice(0, -1))} disabled={!shapes.length} title="Undo (Ctrl+Z)" aria-label="Undo"><Icon name="undo" /></button>
        <button onClick={() => setShapes([])} disabled={!shapes.length} title="Clear" aria-label="Clear"><Icon name="trash" /></button>
        <span className="markup-sep" />
        <button onClick={onClose} title="Cancel (Esc)">Cancel</button>
        <button className="primary" onClick={() => void send()} disabled={!shapes.length || busy} title="Put this frame with your drawing in the chat (Enter)">
          {busy ? "Adding…" : "Send to chat"}
        </button>
      </div>
      {!shapes.length && <div className="markup-hint">Draw, box or point at what you mean, then send it to the chat</div>}
    </div>
  );
}
