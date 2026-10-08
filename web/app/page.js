'use client';

import { useState, useEffect } from 'react';
import { usePrivy } from '@privy-io/react-auth';

const FALLBACK_AGENTS = [
  { id: 'publisher', label: 'Publisher', blurb: 'proposes transactions' },
  { id: 'signer',    label: 'Signer',    blurb: 'co-signs / executes' },
];

export default function Home() {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const [agents, setAgents] = useState(FALLBACK_AGENTS);
  const [agent, setAgent]   = useState(FALLBACK_AGENTS[0].id);
  const [input, setInput]   = useState('');
  const [log, setLog]       = useState([]);
  const [busy, setBusy]     = useState(false);

  // Load the roster (SAGE 2 agents, or the full PRIVATE team) from the server.
  useEffect(() => {
    fetch('/api/agents')
      .then(r => r.json())
      .then(d => { if (d.agents?.length) { setAgents(d.agents); setAgent(d.agents[0].id); } })
      .catch(() => {});
  }, []);

  if (!ready) return <div className="gate"><h1>SAGE</h1><p className="who">loading…</p></div>;

  if (!authenticated) {
    return (
      <div className="gate">
        <h1>SAGE</h1>
        <p className="who">Your agents. Your keys. Your rules.</p>
        <button onClick={login}>Sign in to talk to your agents</button>
        <p className="hint">Social login (email / Google / wallet) via Privy.</p>
      </div>
    );
  }

  const operator =
    user?.email?.address ||
    user?.google?.email ||
    user?.wallet?.address ||
    user?.id;

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setInput('');
    setLog(l => [...l, { role: 'me', text: message }]);
    setBusy(true);
    try {
      const accessToken = await getAccessToken();
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent, message, accessToken }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        setLog(l => [...l, { role: agent, text: `⚠ ${data.reason || data.error || 'request failed'}` }]);
      } else {
        setLog(l => [...l, { role: agent, text: data.reply || '(no reply)', tools: data.tools_used }]);
      }
    } catch (e) {
      setLog(l => [...l, { role: agent, text: `⚠ ${e.message}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <div className="topbar">
        <div className="who">signed in as <b>{operator}</b></div>
        <button className="ghost" onClick={logout}>Sign out</button>
      </div>

      <div className="agents">
        {agents.map(a => (
          <button
            key={a.id}
            className={agent === a.id ? 'active' : ''}
            onClick={() => setAgent(a.id)}
            title={a.blurb}
          >
            {a.label} <span className="who">· {a.blurb}</span>
          </button>
        ))}
      </div>

      <div className="log">
        {log.length === 0 && (
          <div className="msg">
            <div className="role">{agent}</div>
            Ask me things like “what’s pending?”, “simulate sending 50 USDC to #3”,
            {agent === 'signer' ? ' or “approve everything I’ve reviewed”.' : ' or “propose 100 USDC to acme.eth”.'}
          </div>
        )}
        {log.map((m, i) => (
          <div key={i} className={`msg ${m.role === 'me' ? 'me' : ''}`}>
            <div className="role">{m.role === 'me' ? 'you' : m.role}</div>
            {m.text}
            {m.tools?.length > 0 && (
              <div className="tools">
                tools: {m.tools.map((t, j) => <code key={j}>{t.name}{j < m.tools.length - 1 ? ', ' : ''}</code>)}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="composer">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send()}
          placeholder={busy ? 'thinking…' : `message the ${agent} agent…`}
          disabled={busy}
        />
        <button onClick={send} disabled={busy || !input.trim()}>Send</button>
      </div>
      <p className="hint">
        Your login identity is passed to the agent as the authorised <b>operator</b> —
        the same identity SAGE binds signing authority to.
      </p>
    </div>
  );
}
