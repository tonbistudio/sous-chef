/**
 * localStorage and sessionStorage that never throw. Inside a sandboxed iframe
 * (the Hermes page) storage can be blocked; then values live in memory only.
 */
function safe(kind: "localStorage" | "sessionStorage") {
  const memory = new Map<string, string>();
  let real: Storage | null = null;
  try {
    real = window[kind];
    real.setItem("sous.probe", "1");
    real.removeItem("sous.probe");
  } catch {
    real = null;
  }
  return {
    persistent: real !== null,
    get(key: string): string | null {
      try {
        return real ? real.getItem(key) : (memory.get(key) ?? null);
      } catch {
        return memory.get(key) ?? null;
      }
    },
    set(key: string, value: string): void {
      memory.set(key, value);
      try {
        real?.setItem(key, value);
      } catch {
        /* memory copy is enough */
      }
    },
  };
}

export const local = safe("localStorage");
export const session = safe("sessionStorage");
