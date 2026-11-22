import type { ChatAgent } from "./remote.js";

/**
 * Talking to Hermes on another computer through its API server (POST /v1/runs, then the run's
 * event stream). Used by the chat panel and the editor's background questions when Settings →
 * Remote agents names an agent. The address may end in /p/<profile> to pick one of its profiles.
 */

export interface RunEvents {
  /** Text written so far, replaced as more arrives. */
  onText?(text: string): void;
  /** A tool the agent started, by name. */
  onTool?(name: string): void;
}

export interface RunInput {
  text: string;
  /** Extra standing instructions for this turn. */
  instructions?: string;
  sessionId?: string | null;
  /** Pictures as data: URLs. */
  images?: string[];
  signal?: AbortSignal;
}

const base = (a: ChatAgent) => a.url.replace(/\/+$/, "").replace(/\/v1$/, "");

async function call(a: ChatAgent, p: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const ctl = new AbortController();
  const timer = init.timeoutMs ? setTimeout(() => ctl.abort(), init.timeoutMs) : null;
  const onAbort = () => ctl.abort();
  init.signal?.addEventListener("abort", onAbort);
  try {
    return await fetch(`${base(a)}${p}`, {
      ...init,
      signal: ctl.signal,
      headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(a.key ? { authorization: `Bearer ${a.key}` } : {}), ...init.headers },
    });
  } catch (e) {
    if (init.signal?.aborted) throw new Error("Stopped.");
    throw new Error(`Couldn't reach the agent at ${base(a)} (${e instanceof Error && e.name === "AbortError" ? "timed out" : e instanceof Error ? e.message : String(e)}).`);
  } finally {
    if (timer) clearTimeout(timer);
    init.signal?.removeEventListener("abort", onAbort);
  }
}

async function failure(res: Response): Promise<string> {
  const b = (await res.json().catch(() => null)) as { error?: { message?: string } | string; message?: string } | null;
  const msg = typeof b?.error === "string" ? b.error : b?.error?.message ?? b?.message ?? res.statusText;
  if (res.status === 401 || res.status === 403) return "The agent refused the key. Check the API key in Settings → Remote agents.";
  if (res.status === 404) return "No Hermes API server at that address. Check the address, and that the API server is turned on there.";
  return `The agent answered ${res.status}: ${msg}`;
}

/** One turn on the remote agent. Resolves with its answer and the session to continue in. */
export async function runRemote(a: ChatAgent, input: RunInput, events: RunEvents = {}): Promise<{ text: string; sessionId: string }> {
  const sessionId = input.sessionId || `sous-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const content = input.images?.length ? [{ type: "text", text: input.text }, ...input.images.map((url) => ({ type: "image_url", image_url: { url } }))] : null;
  const body = { input: content ? [{ role: "user", content }] : input.text, session_id: sessionId, ...(input.instructions ? { instructions: input.instructions } : {}) };
  const started = await call(a, "/v1/runs", { method: "POST", body: JSON.stringify(body), signal: input.signal, timeoutMs: 60_000 });
  if (!started.ok) throw new Error(await failure(started));
  const { run_id: runId } = (await started.json()) as { run_id?: string };
  if (!runId) throw new Error("The agent didn't start a run.");
  const stop = () => void call(a, `/v1/runs/${encodeURIComponent(runId)}/stop`, { method: "POST", body: "{}", timeoutMs: 10_000 }).catch(() => undefined);
  input.signal?.addEventListener("abort", stop, { once: true });

  let text = "";
  let final: string | null = null;
  let error: string | null = null;
  try {
    const res = await call(a, `/v1/runs/${encodeURIComponent(runId)}/events`, { headers: { accept: "text/event-stream" }, signal: input.signal });
    if (res.ok && res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let name = "";
      let data = "";
      const dispatch = () => {
        if (!data) return;
        let ev: Record<string, unknown> = {};
        try {
          ev = JSON.parse(data) as Record<string, unknown>;
        } catch {
          /* not JSON */
        }
        const kind = String(ev.event ?? ev.type ?? name);
        if (kind === "message.delta" && typeof ev.delta === "string") {
          text += ev.delta;
          events.onText?.(text);
        } else if (kind === "message.interim" && typeof ev.text === "string" && !ev.already_streamed) {
          text += (text && !text.endsWith("\n") ? "\n\n" : "") + ev.text;
          events.onText?.(text);
        } else if (kind === "tool.started") {
          events.onTool?.(String(ev.tool ?? ev.name ?? "a tool"));
        } else if (kind === "run.completed") {
          final = typeof ev.output === "string" ? ev.output : text;
        } else if (kind === "run.failed" || kind === "run.interrupted") {
          error = typeof ev.error === "string" ? ev.error : "The agent's run failed.";
        } else if (kind === "run.cancelled") {
          error = "Stopped.";
        }
        data = "";
        name = "";
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (line === "") dispatch();
          else if (line.startsWith(":")) continue;
          else if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trimStart();
        }
        if (final !== null || error) break;
      }
      void reader.cancel().catch(() => undefined);
    }
    // The stream ended without an answer (a proxy cut it, say): ask how the run ended.
    for (let i = 0; final === null && !error && i < 600; i++) {
      if (input.signal?.aborted) throw new Error("Stopped.");
      const r = await call(a, `/v1/runs/${encodeURIComponent(runId)}`, { timeoutMs: 15_000, signal: input.signal });
      if (!r.ok) throw new Error(await failure(r));
      const st = (await r.json()) as { status?: string; output?: string; error?: string };
      if (st.status === "completed") final = st.output ?? text;
      else if (st.status === "failed" || st.status === "interrupted") error = st.error ?? "The agent's run failed.";
      else if (st.status === "cancelled") error = "Stopped.";
      else await new Promise((r2) => setTimeout(r2, 2000));
    }
  } finally {
    input.signal?.removeEventListener("abort", stop);
  }
  if (error) throw new Error(error);
  return { text: (final ?? text).trim(), sessionId };
}

/**
 * Settings → Remote agents → Test: can Sous Chef reach the agent, and can the agent reach Sous Chef's
 * tools? The second part asks it to list projects, which only works if its sous_chef tools connect back.
 */
export async function testChatAgent(a: ChatAgent): Promise<{ ok: boolean; reached: boolean; tools: boolean; message: string }> {
  try {
    const h = await call(a, "/v1/health", { timeoutMs: 15_000 });
    if (!h.ok) return { ok: false, reached: false, tools: false, message: await failure(h) };
  } catch (e) {
    return { ok: false, reached: false, tools: false, message: e instanceof Error ? e.message : String(e) };
  }
  let used = false;
  try {
    const r = await runRemote(
      a,
      { text: "Sous Chef connection test. Call your Sous Chef 'project' tool with action 'list' once, then answer with only the number of projects it lists. If you have no Sous Chef tools, answer exactly: NO TOOLS." },
      { onTool: (n) => (used ||= /project/i.test(n)) },
    );
    if (used && !/NO TOOLS/i.test(r.text)) return { ok: true, reached: true, tools: true, message: "Connected both ways: the agent answered and used Sous Chef's tools." };
    return { ok: false, reached: true, tools: false, message: "The agent answers, but it can't reach Sous Chef's tools yet. Connect it with the command under Remote agents, then restart that Hermes." };
  } catch (e) {
    return { ok: false, reached: true, tools: false, message: e instanceof Error ? e.message : String(e) };
  }
}
