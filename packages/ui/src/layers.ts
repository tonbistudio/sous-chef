import { live as dragging } from "./live";
import { layerBoxes, type Plan, type Segment } from "@sous-chef/core";
import { pieceAt, planIndex } from "./timeIndex";

/**
 * Everything in the preview that is not the main track: pictures and video on
 * other tracks (picture-in-picture, B-roll), music and voiceover, and fades
 * to black on main clips. Drawn above the zoom camera, as export does, and
 * kept in step with the playhead.
 */
/** A seek asked for before the file has loaded is otherwise lost; apply the latest one when it has. */
function catchUp(v: HTMLVideoElement): void {
  v.addEventListener("loadedmetadata", () => {
    const at = Number(v.dataset.at);
    if (Number.isFinite(at)) v.currentTime = at;
  });
}

export class Layers {
  private root: HTMLDivElement;
  private black: HTMLDivElement;
  private els = new Map<string, HTMLVideoElement | HTMLImageElement>();
  private stageAspect = 16 / 9;

  /** Where a rendered HyperFrames overlay can be fetched, or null while it is not rendered. */
  overlayUrl: (id: string) => string | null = () => null;

  constructor(host: HTMLElement, private url: (mediaId: string, still: boolean) => string) {
    this.root = document.createElement("div");
    this.root.className = "layers";
    this.black = document.createElement("div");
    this.black.className = "fade-black";
    this.root.appendChild(this.black);
    host.appendChild(this.root);
  }

  destroy(): void {
    for (const el of this.els.values()) if (el instanceof HTMLVideoElement) el.pause();
    this.root.remove();
    this.els.clear();
  }

  update(plan: Plan | null, tl: number, playing: boolean, silent = false): void {
    if (!plan) return;
    this.stageAspect = plan.width / plan.height;
    // Fades to black on the main track.
    const ix = planIndex(plan);
    let dark = 0;
    const s = pieceAt(ix.main, tl);
    if (s) {
      if (s.fadeInUs > 0 && tl < s.clipStartUs + s.fadeInUs) dark = Math.max(dark, 1 - (tl - s.clipStartUs) / s.fadeInUs);
      if (s.fadeOutUs > 0 && tl > s.clipEndUs - s.fadeOutUs) dark = Math.max(dark, 1 - (s.clipEndUs - tl) / s.fadeOutUs);
    } else dark = 1; // Nothing on the main track here: black, as it will export.
    const opacity = dark.toFixed(3);
    if (this.black.style.opacity !== opacity) this.black.style.opacity = opacity;

    const live = new Set<string>();
    const others = ix.others.filter((o) => tl >= o.tlStartUs && tl < o.tlEndUs);
    // Lower tracks first, so the stacking matches export.
    others.forEach((seg, z) => {
      const key = `${seg.clipId}:${seg.srcInUs}`;
      live.add(key);
      let el = this.els.get(key);
      if (!el) {
        if (seg.still) {
          const img = document.createElement("img");
          img.src = this.url(seg.mediaId, true);
          el = img;
        } else {
          const v = document.createElement("video");
          v.playsInline = true;
          v.preload = "auto";
          v.src = this.url(seg.mediaId, false);
          catchUp(v);
          el = v;
        }
        el.className = "layer";
        el.draggable = false;
        this.root.insertBefore(el, this.black);
        this.els.set(key, el);
      }
      this.place(el, seg, tl, z);
      if (el instanceof HTMLVideoElement) this.sync(el, seg, tl, playing, silent);
    });
    // Rendered HyperFrames overlays, above the tracks.
    for (const o of plan.overlays) {
      if (o.kind !== "hyperframes" || tl < o.tlStartUs || tl >= o.tlEndUs) continue;
      const src = this.overlayUrl(o.id);
      if (!src) continue;
      const key = `hf:${o.id}:${src}`;
      live.add(key);
      let v = this.els.get(key) as HTMLVideoElement | undefined;
      if (!v) {
        v = document.createElement("video");
        v.playsInline = true;
        v.muted = true;
        v.preload = "auto";
        v.src = src;
        catchUp(v);
        v.className = "layer hf";
        this.root.insertBefore(v, this.black);
        this.els.set(key, v);
      }
      const t = dragging.get(o.id) ?? o.transform;
      v.style.zIndex = "40";
      v.style.width = `${t.scale * 100}%`;
      v.style.height = `${t.scale * 100}%`;
      v.style.left = `${(0.5 + t.x - t.scale / 2) * 100}%`;
      v.style.top = `${(0.5 + t.y - t.scale / 2) * 100}%`;
      v.style.opacity = String(t.opacity);
      const at = (tl - o.tlStartUs) / 1_000_000;
      v.dataset.at = String(at);
      if (v.readyState > 0) {
        if (Math.abs(v.currentTime - at) > (playing ? 0.2 : 0.02)) v.currentTime = at;
        if (playing && v.paused) void v.play().catch(() => undefined);
        if (!playing && !v.paused) v.pause();
      }
    }
    for (const [key, el] of this.els) {
      if (live.has(key)) continue;
      if (el instanceof HTMLVideoElement) {
        el.pause();
        el.removeAttribute("src");
        el.load();
      }
      el.remove();
      this.els.delete(key);
    }
  }

  private fade(seg: Segment, tl: number): number {
    let a = 1;
    if (seg.fadeInUs > 0) a = Math.min(a, (tl - seg.clipStartUs) / seg.fadeInUs);
    if (seg.fadeOutUs > 0) a = Math.min(a, (seg.clipEndUs - tl) / seg.fadeOutUs);
    return Math.max(0, Math.min(1, a));
  }

  private place(el: HTMLElement, seg: Segment, tl: number, z: number): void {
    const t = seg.transform;
    const s = el.style;
    s.zIndex = String(z + 1);
    if (!seg.hasVideo) {
      s.display = "none";
      return;
    }
    s.display = "";
    const { full } = layerBoxes(t, seg.aspect, this.stageAspect);
    s.left = `${full[0] * 100}%`;
    s.top = `${full[1] * 100}%`;
    s.width = `${full[2] * 100}%`;
    s.height = `${full[3] * 100}%`;
    s.opacity = (t.opacity * this.fade(seg, tl)).toFixed(3);
    const [cx, cy, cw, ch] = t.crop;
    const crop = cw < 0.999 || ch < 0.999 || cx > 0.001 || cy > 0.001;
    // Cropping hides the edges; the rest stays where it is.
    s.clipPath = crop ? `inset(${cy * 100}% ${(1 - cx - cw) * 100}% ${(1 - cy - ch) * 100}% ${cx * 100}%)` : "";
  }

  private sync(v: HTMLVideoElement, seg: Segment, tl: number, playing: boolean, silent: boolean): void {
    const src = (seg.srcInUs + (tl - seg.tlStartUs) * seg.speed) / 1_000_000;
    v.dataset.at = String(src);
    v.playbackRate = seg.speed;
    v.muted = silent || seg.muted || !seg.hasAudio;
    v.volume = Math.max(0, Math.min(1, Math.pow(10, seg.volumeDb / 20) * this.fade(seg, tl)));
    if (v.readyState === 0) return;
    // Playing elements drift a little; only a real gap gets a seek, which would stutter.
    const drift = Math.abs(v.currentTime - src);
    if (drift > (playing ? 0.25 : 0.02)) v.currentTime = src;
    if (playing && v.paused) void v.play().catch(() => undefined);
    if (!playing && !v.paused) v.pause();
  }
}
