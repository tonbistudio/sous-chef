import { useEffect, useState } from "react";
import { api, type RemoteView } from "./api";
import type { Editor } from "./useEditor";

/** "3 min ago", "2 days ago", or "never". */
function ago(iso: string | null): string {
  if (!iso) return "never used";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return "used just now";
  if (s < 5400) return `used ${Math.round(s / 60)} min ago`;
  if (s < 129600) return `used ${Math.round(s / 3600)} h ago`;
  return `used ${Math.round(s / 86400)} days ago`;
}

function Copy({ text, label, editor }: { text: string; label: string; editor: Editor }) {
  return (
    <div className="copy-line">
      <code>{text}</code>
      <button className="ghost" onClick={() => void navigator.clipboard.writeText(text).then(() => editor.notify(`Copied the ${label}`), () => editor.notify("Could not copy", "error"))}>
        Copy
      </button>
    </div>
  );
}

/**
 * Settings → Remote agents: let a Hermes on another computer (a VPS, a Spark, a cloud agent) edit
 * the owner's projects, in three plain steps. Optionally, the chat panel talks to that Hermes too.
 */
export function RemoteAgents({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [view, setView] = useState<RemoteView | null>(null);
  const [name, setName] = useState("vps");
  const [made, setMade] = useState<{ key: string; name: string } | null>(null);
  const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [agentOn, setAgentOn] = useState(false);
  const [agentUrl, setAgentUrl] = useState("");
  const [agentKey, setAgentKey] = useState("");
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const fail = (e: unknown) => editor.notify(e instanceof Error ? e.message : String(e), "error");
  const got = (v: RemoteView) => {
    setView(v);
    setAgentOn(Boolean(v.chatAgent));
    setAgentUrl(v.chatAgent?.url ?? "");
  };
  useEffect(() => {
    void api.remote().then(got).catch(fail);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const local = `http://127.0.0.1:${view?.port ?? 47900}`;
  const address = view?.publicUrl || "https://your-tunnel-address";
  const command = `hermes mcp add sous_chef --url ${address}/mcp --auth header`;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal remote" role="dialog" aria-label="Remote agents" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Agents on other computers</h2>
          <button className="ghost" onClick={onClose}>Done</button>
        </header>
        <div className="remote-body">
          <p className="dim">Let a Hermes on a VPS, a Spark or in the cloud edit your projects. This computer still does the heavy work; the agent only gets small clips, frames and transcripts.</p>

          <label className="set-row check">
            <input type="checkbox" checked={Boolean(view?.enabled)} disabled={!view} onChange={(e) => void api.setRemote({ enabled: e.target.checked }).then(got).catch(fail)} />
            <span>Allow remote agents</span>
          </label>
          {view?.enabled && view.status.error && <p className="remote-bad">{view.status.error}</p>}

          {view?.enabled && (
            <>
              <section>
                <h3><b>1</b> Point a tunnel at Sous Chef</h3>
                <p className="dim">Cloudflare Tunnel, Tailscale Funnel or similar should forward to:</p>
                <Copy text={local} label="local address" editor={editor} />
                <label className="set-row">
                  <span>Its public address</span>
                  <input
                    key={view.publicUrl} defaultValue={view.publicUrl} placeholder="https://sous.example.com" spellCheck={false}
                    onBlur={(e) => e.target.value.trim() !== view.publicUrl && void api.setRemote({ publicUrl: e.target.value }).then((v) => (got(v), setCheck(null))).catch(fail)}
                    onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  />
                  <button className="ghost" disabled={!view.publicUrl || checking} onClick={() => (setChecking(true), void api.checkRemote().then(setCheck).catch(fail).finally(() => setChecking(false)))}>
                    {checking ? "Checking…" : "Check"}
                  </button>
                </label>
                {check && <p className={check.ok ? "remote-good" : "remote-bad"}>{check.message}</p>}
              </section>

              <section>
                <h3><b>2</b> Connect an agent</h3>
                <div className="set-row">
                  <span>Name it</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="vps" spellCheck={false} />
                  <button className="primary" disabled={!name.trim()} onClick={() => void api.makeAgentKey(name).then((k) => (setMade({ key: k.key, name: k.name }), api.remote().then(got))).catch(fail)}>
                    Make a key
                  </button>
                </div>
                {made && (
                  <div className="remote-made">
                    <p>On <b>{made.name}</b>, run:</p>
                    <Copy text={command} label="command" editor={editor} />
                    <p>When it asks for a key, paste this. It's shown only once:</p>
                    <Copy text={made.key} label="key" editor={editor} />
                    <p className="dim">Then restart Hermes there. Its edits show in your undo list as "{made.name}: …".</p>
                  </div>
                )}
                {view.keys.length > 0 && (
                  <ul className="remote-keys">
                    {view.keys.map((k) => (
                      <li key={k.id}>
                        <span>{k.name}</span>
                        <span className="dim">{ago(k.lastUsedAt)}</span>
                        <button className="ghost" title="It stops working at once" onClick={() => void api.removeAgentKey(k.id).then((v) => (got(v), made?.name === k.name && setMade(null))).catch(fail)}>
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}

          <section>
            <h3><b>{view?.enabled ? 3 : "·"}</b> Chat with it here <span className="dim">(optional)</span></h3>
            <label className="set-row check">
              <input
                type="checkbox" checked={agentOn}
                onChange={(e) => {
                  setAgentOn(e.target.checked);
                  setTest(null);
                  if (!e.target.checked && view?.chatAgent) void api.setChatAgent(null).then(got).catch(fail);
                }}
              />
              <span>The chat panel talks to Hermes on another computer</span>
            </label>
            {agentOn && (
              <>
                <p className="dim">Turn on Hermes's API server there (<code>API_SERVER_ENABLED=true</code> and an <code>API_SERVER_KEY</code> in its .env), then give its address and key.</p>
                <label className="set-row">
                  <span>Address</span>
                  <input value={agentUrl} onChange={(e) => setAgentUrl(e.target.value)} placeholder="https://my-vps.example.com" spellCheck={false} />
                </label>
                <label className="set-row">
                  <span>API key</span>
                  <input type="password" value={agentKey} onChange={(e) => setAgentKey(e.target.value)} placeholder={view?.chatAgent?.hasKey ? "saved" : ""} autoComplete="off" />
                </label>
                <div className="remote-actions">
                  <button
                    className="primary" disabled={!agentUrl.trim() || testing}
                    onClick={() => {
                      setTesting(true);
                      setTest(null);
                      void api
                        .setChatAgent({ url: agentUrl.trim(), key: agentKey || undefined })
                        .then((v) => (got(v), setAgentKey(""), api.testChatAgent()))
                        .then(setTest)
                        .catch(fail)
                        .finally(() => setTesting(false));
                    }}
                  >
                    {testing ? "Testing… (about 30 s)" : "Save and test"}
                  </button>
                </div>
                {test && <p className={test.ok ? "remote-good" : "remote-bad"}>{test.message}</p>}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
