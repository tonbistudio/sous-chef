import type { Transform } from "@sous-chef/core";

/**
 * Where text and graphics are while being dragged on the preview, before the move is saved. The preview
 * draws from here so what is dragged follows the pointer; the project changes once, on release.
 */
const map = new Map<string, Transform>();
const listeners = new Set<() => void>();
let version = 0;
const tell = () => {
  version++;
  for (const fn of listeners) fn();
};

export const live = {
  get: (id: string): Transform | undefined => map.get(id),
  set(id: string, t: Transform): void {
    map.set(id, t);
    tell();
  },
  clear(id: string): void {
    if (map.delete(id)) tell();
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  version: (): number => version,
};
