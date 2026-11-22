import { cameraAt, layerBoxes, type Plan, type Segment } from "@sous-chef/core";
import { pieceAt, pieceFrom, planIndex } from "./timeIndex";
import { api } from "./api";
import { Layers } from "./layers";

/**
 * Plays a plan in the preview.
 *
 * The main track runs through two <video> elements that take turns: while one
 * plays a piece, the other is already loaded and parked on the first frame of
 * the next piece, so a cut is a swap, not a seek. The playhead lives here,
 * outside React, so only the parts of the UI that show it re-render.
 *
 * The camera (smooth zoom) is the same pure function export uses, applied as
 * a transform on the picture every frame.
 */
/** Transitions the preview draws by playing both pictures at once. */
const BLENDS = new Set(["dissolve", "wipe", "slide", "zoom"]);
const transitionCache = new WeakMap<Plan, Segment[]>();
/** Main-track pieces that come in with a transition. */
function transitionsOf(plan: Plan): Segment[] {
  let list = transitionCache.get(plan);
  if (!list) {
    list = plan.segments.filter((sg) => sg.trackKind === "main" && sg.transitionIn);
    transitionCache.set(plan, list);
  }
  return list;
}

export class Player {
  tlUs = 0;
  playing = false;
  private host: HTMLElement | null = null;
  private world: HTMLDivElement | null = null;
  private els: HTMLVideoElement[] = [];
  /** Which element shows the current piece. */
  private cur = 0;
  private loaded: string[] = ["", ""];
  private pending: (number | null)[] = [null, null];
  private parked: Segment | null = null;
  private plan: Plan | null = null;
  private pid = "";
  private seg: Segment | null = null;
  private raf = 0;
  private listeners = new Set<() => void>();
  private proxies = new Set<string>();
  private cameraOn = true;
  /** While recording a voiceover nothing in the preview makes a sound. */
  private silent = false;
  private overlayKeys: Record<string, string> = {};
  private layers: Layers | null = null;
  /** Wall-clock time of the last tick, for stretches with nothing on the main track. */
  private lastTick = 0;
  /** Sound of the two main elements runs through gains, so a cut can crossfade instead of jumping. */
  private audio: AudioContext | null = null;
  private gains: GainNode[] = [];
  private fading = 0;
  /** Extra things to keep in step with the playhead (captions, overlays, other tracks). */
  private followers = new Set<(tlUs: number, playing: boolean) => void>();
  /** A colour over the picture for dips to white or black at a cut. */
  private dip: HTMLDivElement | null = null;
  /** A blend in progress: both elements play, the incoming one started half a blend before the cut. */
  private blend: { next: Segment; inEl: number; outEl: number; cut: number; h: number; kind: string; started: boolean; swapped: boolean } | null = null;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Called on every playhead change with the time and whether it is playing. */
  follow(fn: (tlUs: number, playing: boolean) => void): () => void {
    this.followers.add(fn);
    return () => this.followers.delete(fn);
  }

  getTime = (): number => this.tlUs;

  /** Redraws what is over the picture (e.g. while text or a graphic is dragged), without moving the playhead. */
  refresh(): void {
    this.emit();
  }
  getPlaying = (): boolean => this.playing;

  private emit(): void {
    this.applyCamera();
    this.applyTransition();
    this.layers?.update(this.plan, this.tlUs, this.playing, this.silent);
    for (const fn of this.followers) fn(this.tlUs, this.playing);
    for (const fn of this.listeners) fn();
  }

  get durationUs(): number {
    return this.plan?.durationUs ?? 0;
  }

  /** Gives the player a box to draw in. It creates and owns everything inside. */
  attach(host: HTMLElement | null): void {
    if (this.host === host) return;
    this.pause();
    this.world?.remove();
    this.layers?.destroy();
    this.layers = null;
    this.host = host;
    this.world = null;
    this.els = [];
    this.loaded = ["", ""];
    this.pending = [null, null];
    this.parked = null;
    if (!host) return;
    const world = document.createElement("div");
    world.className = "world";
    for (let i = 0; i < 2; i++) {
      const v = document.createElement("video");
      v.playsInline = true;
      v.preload = "auto";
      v.className = "main-layer";
      v.style.opacity = i === 0 ? "1" : "0";
      v.addEventListener("loadedmetadata", () => {
        const at = this.pending[i];
        if (at !== null && at !== undefined) {
          v.currentTime = at / 1_000_000;
          this.pending[i] = null;
        }
      });
      world.appendChild(v);
      this.els.push(v);
    }
    host.appendChild(world);
    this.world = world;
    const dip = document.createElement("div");
    dip.className = "dip";
    dip.style.cssText = "position:absolute;inset:0;pointer-events:none;opacity:0";
    host.appendChild(dip);
    this.dip = dip;
    this.blend = null;
    // Images are never proxied; video on other tracks uses the proxy when there is one.
    this.layers = new Layers(host, (id, still) => (still ? api.mediaUrl(this.pid, id, false) : this.url(id)));
    this.layers.overlayUrl = (id) => (this.overlayKeys[id] ? `${api.overlayUrl(this.pid, id)}&v=${this.overlayKeys[id]}` : null);
    this.cur = 0;
    this.seek(this.tlUs);
  }

  /** The element playing now. Other tracks and tests read it. */
  get video(): HTMLVideoElement | null {
    return this.els[this.cur] ?? null;
  }

  setPlan(plan: Plan, pid: string): void {
    this.endBlend();
    this.plan = plan;
    this.pid = pid;
    this.parked = null;
    // Keep the playhead where it was, as far as the new edit allows.
    this.seek(Math.min(this.tlUs, Math.max(0, plan.durationUs - 1)));
  }

  /** Which media have a proxy built. Playback switches to it as soon as it exists. */
  setProxies(ids: string[]): void {
    const next = new Set(ids);
    const changed = next.size !== this.proxies.size || ids.some((id) => !this.proxies.has(id));
    this.proxies = next;
    if (changed) {
      this.loaded = ["", ""];
      this.parked = null;
      if (this.plan) this.seek(this.tlUs);
    }
  }

  private url(mediaId: string): string {
    return api.mediaUrl(this.pid, mediaId, this.proxies.has(mediaId));
  }

  private mainSegments(): Segment[] {
    return this.plan ? planIndex(this.plan).mainVideo : [];
  }

  private segmentAt(tlUs: number): Segment | null {
    return pieceAt(this.mainSegments(), tlUs);
  }

  private nextAfter(seg: Segment): Segment | null {
    return pieceFrom(this.mainSegments(), seg.tlEndUs);
  }

  /** Points an element at a moment of a media file. */
  private cue(i: number, seg: Segment, srcUs: number): void {
    const v = this.els[i];
    if (!v) return;
    const key = this.url(seg.mediaId);
    v.playbackRate = seg.speed;
    this.frame(v, seg);
    v.muted = seg.muted || this.silent;
    v.volume = Math.max(0, Math.min(1, Math.pow(10, seg.volumeDb / 20)));
    const g = this.gains[i];
    if (g && this.audio) {
      // Gain carries the level once the sound runs through the graph; louder than the original is allowed.
      v.volume = 1;
      g.gain.cancelScheduledValues(this.audio.currentTime);
      g.gain.setValueAtTime(seg.muted || this.silent ? 0 : Math.pow(10, seg.volumeDb / 20), this.audio.currentTime);
    }
    if (this.loaded[i] !== key) {
      this.loaded[i] = key;
      this.pending[i] = srcUs;
      v.src = key;
      v.load();
    } else if (v.readyState === 0) {
      this.pending[i] = srcUs;
    } else if (Math.abs(v.currentTime * 1_000_000 - srcUs) > 1000) {
      v.currentTime = srcUs / 1_000_000;
    }
  }

  /** Sizes, places and crops the main picture the same way export does. */
  private frame(v: HTMLVideoElement, seg: Segment): void {
    const t = seg.transform;
    const s = v.style;
    const plain = !t || (Math.abs(t.x) < 1e-4 && Math.abs(t.y) < 1e-4 && Math.abs(t.scale - 1) < 1e-4 && t.crop[0] < 1e-4 && t.crop[1] < 1e-4 && t.crop[2] > 0.9999 && t.crop[3] > 0.9999);
    if (plain || !this.plan) {
      s.left = s.top = s.width = s.height = s.clipPath = s.objectFit = "";
      return;
    }
    const { full } = layerBoxes(t, seg.aspect, this.plan.width / this.plan.height);
    s.left = `${full[0] * 100}%`;
    s.top = `${full[1] * 100}%`;
    s.width = `${full[2] * 100}%`;
    s.height = `${full[3] * 100}%`;
    s.objectFit = "fill";
    const [cx, cy, cw, ch] = t.crop;
    const crop = cw < 0.999 || ch < 0.999 || cx > 0.001 || cy > 0.001;
    s.clipPath = crop ? `inset(${cy * 100}% ${(1 - cx - cw) * 100}% ${(1 - cy - ch) * 100}% ${cx * 100}%)` : "";
  }

  private reveal(i: number): void {
    this.els.forEach((v, k) => (v.style.opacity = k === i ? "1" : "0"));
    this.cur = i;
  }

  /** Half a blend (µs of timeline) coming into this piece, or 0. Dips to a colour are not blends. */
  private blendHalf(seg: Segment | null): number {
    const t = seg?.transitionIn;
    return t && BLENDS.has(t.kind) ? t.durationUs / 2 : 0;
  }

  /** Loads the piece after the current one into the idle element, parked on its first frame (or half a blend before it). */
  private park(): void {
    if (this.blend) return;
    const next = this.seg ? this.nextAfter(this.seg) : null;
    if (!next || next === this.parked) return;
    const idle = 1 - this.cur;
    this.els[idle]?.pause();
    const touching = this.seg && Math.abs(next.tlStartUs - this.seg.tlEndUs) < 2000;
    const lead = touching ? Math.round(this.blendHalf(next) * next.speed) : 0;
    this.cue(idle, next, Math.max(0, next.srcInUs - lead));
    this.parked = next;
  }

  /** Puts both elements back to plain: the current one showing, the other hidden. */
  private endBlend(): void {
    const b = this.blend;
    this.blend = null;
    for (const v of this.els) {
      v.style.transform = "";
      v.style.zIndex = "";
    }
    if (!b) return;
    const out = this.els[b.outEl];
    if (out && b.swapped) out.pause();
    this.reveal(this.cur);
    // A crop on a main clip uses the clip path too; put it back.
    for (const [i, v] of this.els.entries()) {
      const seg = i === this.cur ? this.seg : null;
      v.style.clipPath = "";
      if (seg) this.frame(v, seg);
    }
  }

  /** Draws dips and blends for the playhead's moment. */
  private applyTransition(): void {
    const plan = this.plan;
    if (!plan) return;
    // Dips: the colour rises to the cut and clears after it, playing or not.
    let dip = 0;
    let colour = "";
    for (const sg of transitionsOf(plan)) {
      const t = sg.transitionIn!;
      if (t.kind !== "white" && t.kind !== "black") continue;
      const h = t.durationUs / 2;
      const d = Math.abs(this.tlUs - sg.tlStartUs);
      if (d < h) {
        dip = 1 - d / h;
        colour = t.kind === "white" ? "#fff" : "#000";
        break;
      }
    }
    if (this.dip) {
      this.dip.style.opacity = dip ? dip.toFixed(3) : "0";
      if (colour) this.dip.style.background = colour;
    }
    const b = this.blend;
    if (!b || !b.started) return;
    const p = Math.max(0, Math.min(1, (this.tlUs - (b.cut - b.h)) / (2 * b.h)));
    const inV = this.els[b.inEl];
    const outV = this.els[b.outEl];
    if (!inV || !outV) return;
    inV.style.opacity = "1";
    outV.style.opacity = "1";
    inV.style.transform = outV.style.transform = "";
    inV.style.clipPath = outV.style.clipPath = "";
    if (b.kind === "zoom") {
      // The old picture pushes in and fades, showing the new one beneath.
      outV.style.zIndex = "2";
      inV.style.zIndex = "1";
      outV.style.transform = `scale(${(1 + p * 0.6).toFixed(4)})`;
      outV.style.opacity = (1 - p).toFixed(3);
      return;
    }
    inV.style.zIndex = "2";
    outV.style.zIndex = "1";
    if (b.kind === "dissolve") inV.style.opacity = p.toFixed(3);
    else if (b.kind === "wipe") inV.style.clipPath = `inset(0 0 0 ${((1 - p) * 100).toFixed(2)}%)`;
    else if (b.kind === "slide") {
      inV.style.transform = `translateX(${((1 - p) * 100).toFixed(2)}%)`;
      outV.style.transform = `translateX(${(-p * 100).toFixed(2)}%)`;
    }
  }

  /**
   * After a seek into a blend (or a pause in one): both pictures cued at the right moments and drawn
   * mixed, so a paused frame shows the transition and Play from inside it runs it smoothly. Before the
   * cut the incoming picture runs ahead of its first frame; after it, the outgoing one runs past its last.
   */
  private armBlend(seg: Segment, t: number): void {
    const main = this.mainSegments();
    const i = main.indexOf(seg);
    if (i < 0) return;
    const nextUp = main[i + 1];
    const prev = main[i - 1];
    const touching = (a: Segment | undefined, b: Segment | undefined) => Boolean(a && b && Math.abs(a.tlEndUs - b.tlStartUs) < 2000);
    let incoming: Segment | null = null;
    let outgoing: Segment | null = null;
    if (nextUp && touching(seg, nextUp) && this.blendHalf(nextUp) > 0 && t >= nextUp.tlStartUs - this.blendHalf(nextUp)) {
      incoming = nextUp;
      outgoing = seg;
    } else if (prev && touching(prev, seg) && this.blendHalf(seg) > 0 && t < seg.tlStartUs + this.blendHalf(seg)) {
      incoming = seg;
      outgoing = prev;
    }
    if (!incoming || !outgoing) return;
    const h = this.blendHalf(incoming);
    const cut = incoming.tlStartUs;
    const idle = 1 - this.cur;
    const other = this.els[idle];
    if (!other) return;
    other.pause();
    if (incoming === seg) {
      // Past the cut: the old picture plays on past its end, silent, fading out.
      this.cue(idle, outgoing, outgoing.srcOutUs + Math.round((t - cut) * outgoing.speed));
      this.blend = { next: incoming, inEl: this.cur, outEl: idle, cut, h, kind: incoming.transitionIn!.kind, started: true, swapped: true };
      this.parked = null;
    } else {
      // Before the cut: the new picture is already running, silent, fading in.
      this.cue(idle, incoming, Math.max(0, incoming.srcInUs - Math.round((cut - t) * incoming.speed)));
      this.blend = { next: incoming, inEl: idle, outEl: this.cur, cut, h, kind: incoming.transitionIn!.kind, started: true, swapped: false };
      this.parked = incoming;
    }
    other.muted = true;
    this.gains[idle]?.gain.setValueAtTime(0, this.audio?.currentTime ?? 0);
    if (this.playing) void other.play().catch(() => undefined);
  }

  /** In empty space: gets the next piece loaded and waiting, so it starts without a stall. */
  private parkAhead(): void {
    const next = this.mainSegments().find((s) => s.tlStartUs > this.tlUs);
    if (!next || next === this.parked) return;
    this.els[this.cur]?.pause();
    this.cue(this.cur, next, next.srcInUs);
    this.parked = next;
  }

  private show(seg: Segment, srcUs: number): void {
    this.seg = seg;
    const v = this.els[this.cur];
    if (!v) return;
    this.els[1 - this.cur]?.pause();
    this.cue(this.cur, seg, srcUs);
    this.parked = null;
    if (this.playing) void v.play().catch(() => undefined);
    this.park();
  }

  setSilent(on: boolean): void {
    this.silent = on;
    for (const v of this.els) if (on) v.muted = true;
    if (!on && this.seg) {
      const v = this.els[this.cur];
      if (v) v.muted = this.seg.muted;
    }
    this.emit();
  }

  /** Tells the preview which HyperFrames overlays are rendered (id → version key). */
  setRenderedOverlays(keys: Record<string, string>): void {
    this.overlayKeys = keys;
    if (this.layers) this.layers.overlayUrl = (id) => (this.overlayKeys[id] ? `${api.overlayUrl(this.pid, id)}&v=${this.overlayKeys[id]}` : null);
    this.emit();
  }

  /** Turn the zoom off to show the whole picture, e.g. while a zoom's box is being edited. */
  setCameraEnabled(on: boolean): void {
    this.cameraOn = on;
    this.applyCamera();
  }

  private applyCamera(): void {
    if (!this.world || !this.plan) return;
    if (!this.plan.camera.length || !this.cameraOn) {
      if (this.world.style.transform) this.world.style.transform = "";
      return;
    }
    const c = cameraAt(this.plan, this.tlUs);
    this.world.style.transform =
      c.scale <= 1.000001 ? "" : `translate(${((0.5 - c.cx * c.scale) * 100).toFixed(4)}%, ${((0.5 - c.cy * c.scale) * 100).toFixed(4)}%) scale(${c.scale.toFixed(5)})`;
  }

  seek(tlUs: number): void {
    this.endBlend();
    const duration = this.durationUs;
    const t = Math.max(0, Math.min(tlUs, duration));
    this.tlUs = t;
    const seg = this.segmentAt(Math.min(t, Math.max(0, duration - 1)));
    if (seg) {
      this.show(seg, seg.srcInUs + Math.round((Math.min(t, seg.tlEndUs - 1) - seg.tlStartUs) * seg.speed));
      this.armBlend(seg, t);
    } else {
      this.seg = null;
      for (const v of this.els) v.pause();
    }
    this.emit();
  }

  /** Routes the main elements through gains. Made on first play, since browsers only allow sound after a click. */
  private ensureAudio(): void {
    if (this.audio || this.els.length < 2) {
      void this.audio?.resume().catch(() => undefined);
      return;
    }
    try {
      const ctx = new AudioContext();
      this.gains = this.els.map((v, i) => {
        const g = ctx.createGain();
        ctx.createMediaElementSource(v).connect(g).connect(ctx.destination);
        g.gain.value = this.els[i] === this.els[this.cur] && this.seg && !this.seg.muted && !this.silent ? Math.pow(10, this.seg.volumeDb / 20) : 0;
        return g;
      });
      this.audio = ctx;
      for (const v of this.els) v.volume = 1;
      void ctx.resume().catch(() => undefined);
    } catch {
      this.audio = null;
      this.gains = [];
    }
  }

  play(): void {
    if (!this.plan || this.durationUs === 0 || !this.els.length) return;
    this.ensureAudio();
    if (this.tlUs >= this.durationUs - 1000) this.seek(0);
    this.playing = true;
    this.lastTick = performance.now();
    void this.els[this.cur]?.play().catch(() => undefined);
    if (this.blend) void this.els[1 - this.cur]?.play().catch(() => undefined);
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
    this.emit();
  }

  pause(): void {
    this.playing = false;
    if (this.blend) {
      // Stop where it is; seek sets the two pictures up again, so the paused frame shows the blend.
      const t = this.tlUs;
      this.endBlend();
      this.seek(t);
    }
    cancelAnimationFrame(this.raf);
    for (const v of this.els) v.pause();
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  /** Moves by whole frames while paused. */
  step(frames: number): void {
    this.pause();
    const fps = this.plan?.fps ?? 60;
    this.seek(this.tlUs + Math.round((frames * 1_000_000) / fps));
  }

  private tick = (): void => {
    if (!this.playing) return;
    const v = this.els[this.cur];
    const seg = this.seg;
    const now = performance.now();
    const dt = (now - this.lastTick) * 1000;
    this.lastTick = now;
    if (!v || !seg) {
      // Nothing on the main track here (other tracks run on): the clock drives the playhead.
      this.tlUs = Math.min(this.durationUs, this.tlUs + dt);
      if (this.tlUs >= this.durationUs) {
        this.pause();
        return;
      }
      const at = this.segmentAt(this.tlUs);
      if (at) {
        this.reveal(this.cur);
        this.show(at, at.srcInUs + Math.round((this.tlUs - at.tlStartUs) * at.speed));
      } else this.parkAhead();
      this.emit();
      this.raf = requestAnimationFrame(this.tick);
      return;
    }
    // A blend into the next piece: start the incoming picture half a blend before the cut.
    if (!this.blend && this.parked) {
      const next = this.parked;
      const h = this.blendHalf(next);
      if (h > 0 && Math.abs(next.tlStartUs - seg.tlEndUs) < 2000 && this.tlUs >= next.tlStartUs - h) {
        const idle = 1 - this.cur;
        const other = this.els[idle];
        if (other && other.readyState >= 2 && !other.seeking) {
          // Where the incoming picture should be now: half a blend before its first frame, plus however
          // far the playhead is into the blend. Started late (still loading), it catches up instead of
          // starting behind and jumping at the cut.
          const want = next.srcInUs - Math.round((next.tlStartUs - this.tlUs) * next.speed);
          if (Math.abs(other.currentTime * 1e6 - want) > 60_000) other.currentTime = Math.max(0, want) / 1e6;
          // Heard from the cut, as before: until then it plays silently.
          other.muted = true;
          this.gains[idle]?.gain.setValueAtTime(0, this.audio?.currentTime ?? 0);
          void other.play().catch(() => undefined);
          this.blend = { next, inEl: idle, outEl: this.cur, cut: next.tlStartUs, h, kind: next.transitionIn!.kind, started: true, swapped: false };
        }
      }
    }
    if (this.blend?.swapped && this.tlUs >= this.blend.cut + this.blend.h) {
      this.endBlend();
      this.park();
    }
    if (!v.seeking && v.readyState >= 2 && this.pending[this.cur] === null) {
      const srcUs = v.currentTime * 1_000_000;
      const halfFrame = 500_000 / (this.plan?.fps ?? 60);
      if (srcUs >= seg.srcOutUs - halfFrame || v.ended) {
        const found = this.nextAfter(seg);
        // Empty space after this piece: the clock carries the playhead across it.
        const next = found && found.tlStartUs - seg.tlEndUs > 2000 ? null : found;
        if (!next) {
          this.tlUs = seg.tlEndUs;
          if (this.tlUs >= this.durationUs - 1000) {
            this.tlUs = this.durationUs;
            this.pause();
            return;
          }
          // Other tracks go on after the main track ends.
          v.pause();
          this.seg = null;
          this.emit();
          this.raf = requestAnimationFrame(this.tick);
          return;
        }
        const idle = 1 - this.cur;
        const other = this.els[idle]!;
        if (this.blend && this.blend.next === next && !this.blend.swapped) {
          // Mid-blend: the new piece takes over the clock and the sound; the old one plays on, fading.
          this.blend.swapped = true;
          this.seg = next;
          this.tlUs = next.tlStartUs;
          this.cur = idle;
          this.parked = null;
          other.muted = next.muted || this.silent;
          const ctx = this.audio;
          const gOld = this.gains[1 - idle];
          const gNew = this.gains[idle];
          if (ctx && gOld && gNew) {
            const now = ctx.currentTime;
            gNew.gain.cancelScheduledValues(now);
            gNew.gain.setValueAtTime(0, now);
            gNew.gain.linearRampToValueAtTime(next.muted || this.silent ? 0 : Math.pow(10, next.volumeDb / 20), now + 0.024);
            gOld.gain.cancelScheduledValues(now);
            gOld.gain.setValueAtTime(gOld.gain.value, now);
            gOld.gain.linearRampToValueAtTime(0, now + 0.024);
          } else v.muted = true;
        } else if (this.parked === next && other.readyState >= 2 && !other.seeking) {
          // The next piece is already waiting on its first frame: swap. With sound running through gains,
          // the old piece keeps playing a moment while it fades out and the new one fades in.
          this.seg = next;
          this.tlUs = next.tlStartUs;
          this.reveal(idle);
          void other.play().catch(() => undefined);
          this.parked = null;
          const ctx = this.audio;
          const gOld = this.gains[1 - idle];
          const gNew = this.gains[idle];
          if (ctx && gOld && gNew && !seg.muted && !next.muted && !this.silent) {
            const now = ctx.currentTime;
            const level = Math.pow(10, next.volumeDb / 20);
            gNew.gain.cancelScheduledValues(now);
            gNew.gain.setValueAtTime(0, now);
            gNew.gain.linearRampToValueAtTime(level, now + 0.024);
            gOld.gain.cancelScheduledValues(now);
            gOld.gain.setValueAtTime(gOld.gain.value, now);
            gOld.gain.linearRampToValueAtTime(0, now + 0.024);
            const token = ++this.fading;
            window.setTimeout(() => {
              if (token !== this.fading) return;
              v.pause();
              if (this.playing) this.park();
            }, 40);
          } else {
            v.pause();
            this.park();
          }
        } else {
          this.tlUs = next.tlStartUs;
          this.show(next, next.srcInUs);
        }
      } else if (srcUs >= seg.srcInUs) {
        this.tlUs = seg.tlStartUs + Math.round((srcUs - seg.srcInUs) / seg.speed);
      }
      this.emit();
    }
    this.raf = requestAnimationFrame(this.tick);
  };
}
