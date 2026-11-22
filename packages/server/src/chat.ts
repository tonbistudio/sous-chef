import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runRemote } from "./agentRemote.js";
import { readRemote, type ChatAgent } from "./remote.js";

/**
 * The chat tab: a conversation with the user's own Hermes agent about the
 * open project. Each message runs the Hermes command-line program once, in
 * the same Hermes session as the messages before it, and Hermes edits the
 * project through the Sous Chef tools like any other client. Nothing here
 * talks to a model directly, and no key is stored.
 */
/** Where pictures pasted into the chat are kept: inside the project, so they travel with it. */
export function chatImagesDir(projectDir: string): string {
  return path.join(projectDir, "chat-images");
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant" | "error";
  text: string;
  at: number;
  /** Pictures pasted with the message, by file name in the project's chat-images folder. */
  images?: string[];
}

export interface ChatState {
  messages: ChatMessage[];
  running: boolean;
  /** What Hermes is doing right now, in a few words. */
  activity: string;
}

interface Thread {
  messages: ChatMessage[];
  sessionId: string | null;
  /** Profile the session belongs to; "" is the default profile. */
  profile: string;
  child: ChildProcess | null;
  /** A turn on a Hermes on another computer, while it runs. */
  remote: AbortController | null;
  activity: string;
  loaded: boolean;
  stopped?: boolean;
}

/** Stops Hermes and whatever it started. On Windows the program runs under a shell, so the whole tree has to go. */
function killTree(child: ChildProcess | null): void {
  if (!child?.pid) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
  else child.kill();
}

export const HERMES = process.env.SOUS_CHEF_HERMES ?? "hermes";

/** The profile chosen in the editor, as arguments that go before the command. */
async function profileArgs(): Promise<{ args: string[]; name: string }> {
  const { readPreferences } = await import("./library.js");
  const name = (await readPreferences().catch(() => ({ hermesProfile: "" }))).hermesProfile;
  return { args: name ? ["--profile", name] : [], name };
}
const MAX_MESSAGES = 200;
const TIMEOUT_MS = 20 * 60_000;

export class Chats {
  private threads = new Map<string, Thread>();

  constructor(private onChange: (projectId: string, state: ChatState) => void = () => {}) {}

  private file(dir: string): string {
    return path.join(dir, "chat.json");
  }

  private async thread(projectId: string, dir: string): Promise<Thread> {
    let t = this.threads.get(projectId);
    if (!t) {
      t = { messages: [], sessionId: null, profile: "", child: null, remote: null, activity: "", loaded: false };
      this.threads.set(projectId, t);
    }
    if (!t.loaded) {
      t.loaded = true;
      try {
        const saved = JSON.parse(await readFile(this.file(dir), "utf8")) as { messages?: ChatMessage[]; sessionId?: string | null; profile?: string };
        t.messages = Array.isArray(saved.messages) ? saved.messages : [];
        t.sessionId = typeof saved.sessionId === "string" ? saved.sessionId : null;
        t.profile = typeof saved.profile === "string" ? saved.profile : "";
      } catch {
        /* no chat yet */
      }
    }
    return t;
  }

  private view(t: Thread): ChatState {
    return { messages: t.messages, running: Boolean(t.child || t.remote), activity: t.activity };
  }

  private async save(projectId: string, dir: string, t: Thread): Promise<void> {
    t.messages = t.messages.slice(-MAX_MESSAGES);
    this.onChange(projectId, this.view(t));
    await writeFile(this.file(dir), JSON.stringify({ sessionId: t.sessionId, profile: t.profile, messages: t.messages }, null, 1), "utf8").catch(() => undefined);
  }

  async state(projectId: string, dir: string): Promise<ChatState> {
    return this.view(await this.thread(projectId, dir));
  }

  anyRunning(): boolean {
    return [...this.threads.values()].some((t) => t.child || t.remote);
  }

  stop(projectId: string): void {
    const t = this.threads.get(projectId);
    if (t?.child) {
      t.stopped = true;
      killTree(t.child);
    }
    t?.remote?.abort();
  }

  stopAll(): void {
    for (const t of this.threads.values()) {
      killTree(t.child);
      t.remote?.abort();
    }
  }

  /** Forgets the conversation; the next message starts a new Hermes session. */
  async clear(projectId: string, dir: string): Promise<void> {
    const t = await this.thread(projectId, dir);
    killTree(t.child);
    t.remote?.abort();
    t.child = null;
    t.remote = null;
    t.messages = [];
    t.sessionId = null;
    await this.save(projectId, dir, t);
  }

  /** Sends a message. Returns at once; the reply arrives through onChange. */
  async send(projectId: string, dir: string, text: string, context: string, briefing?: () => Promise<string>, images: string[] = []): Promise<void> {
    const t = await this.thread(projectId, dir);
    if (t.child || t.remote) throw new Error("Hermes is still working on the last message.");
    const push = (role: ChatMessage["role"], body: string, pics?: string[]) => t.messages.push({ id: (t.messages[t.messages.length - 1]?.id ?? 0) + 1, role, text: body, at: Date.now(), ...(pics?.length ? { images: pics } : {}) });
    push("user", text, images);
    const agent = (await readRemote().catch(() => null))?.chatAgent;
    if (agent) return this.sendRemote(projectId, dir, t, agent, text, context, briefing, images, push);
    t.activity = "Starting Hermes";

    // A session lives in one profile: after switching profiles the conversation starts again there.
    const profile = await profileArgs();
    if (t.sessionId && t.profile !== profile.name) {
      t.sessionId = null;
      t.messages.splice(t.messages.length - 1, 0, { id: t.messages[t.messages.length - 1]?.id ?? 0, role: "assistant", text: `(Now talking to the ${profile.name || "default"} Hermes profile. It starts fresh and doesn't see the messages above.)`, at: Date.now() });
    }
    t.profile = profile.name;
    // The message goes in on standard input, so nothing in it is ever read by a shell.
    const args = [...profile.args, "chat", "--query-file", "-", "--oneshot", "--format", "stream-json"];
    if (t.sessionId && /^[A-Za-z0-9_-]{6,128}$/.test(t.sessionId)) args.push("--resume", t.sessionId);
    let child: ChildProcess;
    try {
      child = spawn(HERMES, args, { cwd: dir, windowsHide: true, shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      push("error", `Could not start Hermes: ${e instanceof Error ? e.message : String(e)}`);
      t.activity = "";
      await this.save(projectId, dir, t);
      return;
    }
    t.child = child;
    t.stopped = false;
    await this.save(projectId, dir, t);
    // A new conversation starts with what the editor remembers from earlier projects.
    const intro = !t.sessionId && briefing ? await briefing().catch(() => "") : "";
    // Pictures go by path: Hermes looks at them with its vision tool, and can import them as media.
    const paths = images.map((f) => path.join(chatImagesDir(dir), f).replace(/\\/g, "/"));
    const pics = paths.length
      ? `\n\n[The user pasted ${paths.length} picture${paths.length === 1 ? "" : "s"} with this message. Look at ${paths.length === 1 ? "it" : "them"} with your vision tool before answering. ${paths.length === 1 ? "It is" : "They are"} saved in the project folder, so ${paths.length === 1 ? "it" : "they"} can also be imported into the edit as media by path:\n${paths.map((p) => `- ${p}`).join("\n")}]`
      : "";
    child.stdin?.end(`${context}${intro ? `\n\n[Editor library, carried across projects]\n${intro}` : ""}${pics}\n\n${text}`);
    const timer = setTimeout(() => killTree(child), TIMEOUT_MS);

    let buffer = "";
    let reply = "";
    let failure = "";
    let stderr = "";
    let lastTold = 0;
    const tell = () => {
      if (Date.now() - lastTold < 250) return;
      lastTold = Date.now();
      this.onChange(projectId, { ...this.view(t), messages: reply ? [...t.messages, { id: -1, role: "assistant", text: reply, at: Date.now() }] : t.messages });
    };
    child.stdout?.on("data", (d: Buffer) => {
      buffer += d.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (ev.type === "text" && typeof ev.text === "string") {
          reply += (reply && !reply.endsWith("\n") ? "\n\n" : "") + ev.text;
          t.activity = "Writing";
        } else if (ev.type === "result") {
          if (typeof ev.session_id === "string" && ev.session_id) t.sessionId = ev.session_id;
          if (typeof ev.text === "string" && ev.text.trim()) reply = ev.text;
          if (typeof ev.error === "string" && ev.error) failure = ev.error;
        } else if (ev.type !== "system") {
          const name = [ev.name, ev.tool, ev.tool_name, (ev.tool_call as { name?: unknown } | undefined)?.name].find((x) => typeof x === "string") as string | undefined;
          t.activity = name ? `Using ${name.replace(/^mcp__?/, "").replace(/__/g, " › ").replace(/_/g, " ")}` : "Working";
        }
        tell();
      }
    });
    child.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString("utf8")).slice(-1500)));
    const finish = async (problem?: string) => {
      if (t.child !== child) return;
      clearTimeout(timer);
      t.child = null;
      t.activity = "";
      if (reply.trim()) push("assistant", reply.trim());
      const why = problem ?? failure;
      if (why) push("error", why);
      else if (!reply.trim()) push("error", "Hermes stopped without answering.");
      await this.save(projectId, dir, t);
    };
    child.on("error", (e) => void finish(/ENOENT/.test(String(e)) ? "Hermes Agent was not found on this computer. Install it, or set SOUS_CHEF_HERMES to its path." : `Could not run Hermes: ${e.message}`));
    child.on("close", (code, signal) => {
      const notFound = /not recognized|not found|ENOENT/i.test(stderr) && !reply;
      void finish(signal || t.stopped ? "Stopped." : notFound ? "Hermes Agent was not found on this computer. Install it, or set SOUS_CHEF_HERMES to its path." : code && !failure && !reply ? stderr.trim().split(/\r?\n/).slice(-2).join(" ") || `Hermes exited with code ${code}` : undefined);
    });
  }

  /** The same turn, on a Hermes on another computer (Settings → Remote agents). */
  private async sendRemote(projectId: string, dir: string, t: Thread, agent: ChatAgent, text: string, context: string, briefing: (() => Promise<string>) | undefined, images: string[], push: (role: ChatMessage["role"], body: string) => void): Promise<void> {
    const host = (() => {
      try {
        return new URL(agent.url).host;
      } catch {
        return agent.url;
      }
    })();
    // A session belongs to one agent: switching between this computer and another starts afresh.
    const profile = `remote:${host}`;
    if (t.sessionId && t.profile !== profile) {
      t.sessionId = null;
      t.messages.splice(t.messages.length - 1, 0, { id: t.messages[t.messages.length - 1]?.id ?? 0, role: "assistant", text: `(Now talking to Hermes at ${host}. It starts fresh and doesn't see the messages above.)`, at: Date.now() });
    }
    t.profile = profile;
    const ctl = new AbortController();
    t.remote = ctl;
    t.stopped = false;
    t.activity = `Asking Hermes at ${host}`;
    await this.save(projectId, dir, t);
    const intro = !t.sessionId && briefing ? await briefing().catch(() => "") : "";
    // Pictures go along with the message: that computer can't open files on this one.
    const pics = (
      await Promise.all(
        images.map(async (f) => {
          const data = await readFile(path.join(chatImagesDir(dir), f)).catch(() => null);
          const ext = path.extname(f).slice(1).toLowerCase().replace("jpg", "jpeg");
          return data ? `data:image/${ext};base64,${data.toString("base64")}` : null;
        }),
      )
    ).filter((x): x is string => Boolean(x));
    const note = pics.length ? `\n\n[The user attached ${pics.length} picture${pics.length === 1 ? "" : "s"} to this message; look at ${pics.length === 1 ? "it" : "them"} before answering.]` : "";
    let reply = "";
    let lastTold = 0;
    const tell = () => {
      if (Date.now() - lastTold < 250) return;
      lastTold = Date.now();
      this.onChange(projectId, { ...this.view(t), messages: reply ? [...t.messages, { id: -1, role: "assistant", text: reply, at: Date.now() }] : t.messages });
    };
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let problem = "";
    try {
      const r = await runRemote(
        agent,
        { text: `${context}${intro ? `\n\n[Editor library, carried across projects]\n${intro}` : ""}${note}\n\n${text}`, sessionId: t.sessionId, images: pics, signal: ctl.signal },
        {
          onText: (s) => {
            reply = s;
            t.activity = "Writing";
            tell();
          },
          onTool: (n) => {
            t.activity = `Using ${n.replace(/^mcp_+/, "").replace(/^sous_chef_+/, "").replace(/_/g, " ")}`;
            tell();
          },
        },
      );
      t.sessionId = r.sessionId;
      reply = r.text || reply;
    } catch (e) {
      problem = ctl.signal.aborted ? "Stopped." : e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
    }
    if (t.remote !== ctl) return;
    t.remote = null;
    t.activity = "";
    if (reply.trim()) push("assistant", reply.trim());
    if (problem) push("error", problem);
    else if (!reply.trim()) push("error", "Hermes stopped without answering.");
    await this.save(projectId, dir, t);
  }
}

/**
 * Asks Hermes one question and returns its answer as text. Used for jobs that
 * need reading rather than editing; the question goes in on standard input.
 */
export interface AskOptions {
  /**
   * Name of a Hermes session to keep using: every ask with the same name
   * resumes it, so there is one session instead of one per question.
   */
  session?: string;
}

/** Asks with the same session name wait their turn: a session answers one question at a time. */
const sessionQueue = new Map<string, Promise<unknown>>();

export async function askHermes(question: string, cwd: string, timeoutMs = 4 * 60_000, onChild?: (child: ChildProcess) => void, options: AskOptions = {}): Promise<string> {
  const agent = (await readRemote().catch(() => null))?.chatAgent;
  if (agent) {
    // On the agent named in Settings → Remote agents; a named session keeps one conversation per name.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const slug = options.session?.replace(/[^\w-]+/g, "-").slice(0, 80);
      const r = await runRemote(agent, { text: question, sessionId: slug ? `sous-ask-${slug}` : null, signal: ctl.signal });
      if (!r.text) throw new Error("Hermes gave no answer");
      return r.text;
    } finally {
      clearTimeout(timer);
    }
  }
  return askLocal(question, cwd, timeoutMs, onChild, options);
}

function askLocal(question: string, cwd: string, timeoutMs: number, onChild: ((child: ChildProcess) => void) | undefined, options: AskOptions): Promise<string> {
  // Passed through a shell on Windows: keep the name to plain characters.
  const name = options.session?.replace(/[^\w .:-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!name) return profileArgs().then((p) => runHermes(question, cwd, timeoutMs, onChild, [], p.args));
  const prev = sessionQueue.get(name) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(async () => runHermes(question, cwd, timeoutMs, onChild, ["-c", name, "--create-if-missing"], (await profileArgs()).args));
  sessionQueue.set(name, run);
  void run.finally(() => {
    if (sessionQueue.get(name) === run) sessionQueue.delete(name);
  }).catch(() => undefined);
  return run;
}

function runHermes(question: string, cwd: string, timeoutMs: number, onChild: ((child: ChildProcess) => void) | undefined, extra: string[], before: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      // "--source tool": the editor's background questions stay out of the user's session list.
      const args = [...before, "chat", "--query-file", "-", "--oneshot", "--format", "stream-json", "--source", "tool", ...extra];
      child = spawn(HERMES, process.platform === "win32" ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args, { cwd, windowsHide: true, shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return reject(e instanceof Error ? e : new Error(String(e)));
    }
    onChild?.(child);
    const timer = setTimeout(() => killTree(child), timeoutMs);
    let buffer = "";
    let reply = "";
    let final = "";
    child.stdout?.on("data", (d: Buffer) => {
      buffer += d.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        try {
          const ev = JSON.parse(line) as Record<string, unknown>;
          if (ev.type === "text" && typeof ev.text === "string") reply += ev.text;
          if (ev.type === "result" && typeof ev.text === "string") final = ev.text;
        } catch {
          /* not an event line */
        }
      }
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(question);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const answer = (final || reply).trim();
      if (answer) resolve(answer);
      else reject(new Error(`Hermes gave no answer (exit ${code})`));
    });
  });
}

export { killTree };
