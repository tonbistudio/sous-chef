/**
 * Pictures handed to the chat from elsewhere in the editor, such as a marked-up frame from the preview.
 * Kept here until the chat takes them, so one sent while the chat tab is closed still arrives.
 */
export interface ChatAttachment {
  /** File name in the project's chat-images folder. */
  file: string;
  url: string;
  /** What the picture shows, in words Hermes can act on (positions of boxes, points and strokes). */
  note?: string;
}

const waiting: ChatAttachment[] = [];
const listeners = new Set<(a: ChatAttachment) => void>();

export function attachToChat(a: ChatAttachment): void {
  window.dispatchEvent(new CustomEvent("sous:left", { detail: "chat" }));
  if (listeners.size) for (const fn of listeners) fn(a);
  else waiting.push(a);
}

/** The chat listens here; anything that arrived while it was closed is handed over at once. */
export function takeAttachments(fn: (a: ChatAttachment) => void): () => void {
  for (const a of waiting.splice(0)) fn(a);
  listeners.add(fn);
  return () => listeners.delete(fn);
}
