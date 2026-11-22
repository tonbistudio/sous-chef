/** Native file dialogs, present only inside the Electron app. Elsewhere the built-in picker is used. */
export interface DesktopBridge {
  pickMedia(): Promise<string[]>;
  pickProject(): Promise<string | null>;
  newProject(): Promise<string | null>;
  pickFolder?(start?: string): Promise<string | null>;
  pathForFile?(file: File): string;
}

export const desktop: DesktopBridge | null =
  (window as unknown as { sousChefDesktop?: DesktopBridge }).sousChefDesktop ?? null;
