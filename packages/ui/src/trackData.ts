import { api, type Prepared } from "./api";

/** Sound outlines and picture sheets for the timeline, loaded once per media file. */
const waves = new Map<string, Uint8Array | "loading">();
const sheets = new Map<string, HTMLImageElement | "loading">();

export function getWave(pid: string, mediaId: string, onReady: () => void): Uint8Array | null {
  const key = `${pid}/${mediaId}`;
  const have = waves.get(key);
  if (have && have !== "loading") return have;
  if (!have) {
    waves.set(key, "loading");
    api
      .wave(pid, mediaId)
      .then((w) => {
        const bin = atob(w.peaks);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        waves.set(key, arr);
        onReady();
      })
      .catch(() => waves.delete(key));
  }
  return null;
}

export function getSheet(pid: string, mediaId: string, onReady: () => void): HTMLImageElement | null {
  const key = `${pid}/${mediaId}`;
  const have = sheets.get(key);
  if (have && have !== "loading") return have;
  if (!have) {
    sheets.set(key, "loading");
    const img = new Image();
    img.onload = () => {
      sheets.set(key, img);
      onReady();
    };
    img.onerror = () => sheets.delete(key);
    img.src = api.thumbsUrl(pid, mediaId);
  }
  return null;
}

export type PreparedMap = Record<string, Prepared>;
