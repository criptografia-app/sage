import { PrivyClient } from '@privy-io/server-auth';

// Roster of agent services the UI can talk to. Driven by AGENTS_JSON so the same
// frontend serves SAGE (publisher/signer) or the full PRIVATE team (concierge,
// treasury, …) with no code change. Falls back to the two SAGE agents.
import { ROSTER } from '../agents/roster';

const AGENT_URL = Object.fromEntries(ROSTER.map(a => [a.id, a.url]));

const PRIVY_APP_ID     = process.env.PRIVY_APP_ID || process.env.NEXT_PUBLIC_PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;

const privy = (PRIVY_APP_ID && PRIVY_APP_SECRET)
  ? new PrivyClient(PRIVY_APP_ID, PRIVY_APP_SECRET)
  : null;

/**
 * Resolve the authenticated operator from the Privy access token. This is the
 * trust boundary: the browser cannot pick its own operator identity — the agent
 * treats `operator` as the human co-signature, so it MUST be derived from a
 * verified token, never from client-supplied fields.
 *
 * If Privy server credentials aren't configured we fall back to a clearly-marked
 * dev identity so the stack is runnable locally, but that path must never ship.
 */
async function resolveOperator(accessToken) {
  if (!privy) {
    return { operator: 'dev@local', verified: false };
  }
  const claims = await privy.verifyAuthToken(accessToken); // throws if invalid/expired
  let email;
  try {
    const u = await privy.getUser(claims.userId);
    email = u?.email?.address || u?.google?.email || u?.wallet?.address;
  } catch { /* fall through to the userId */ }
  return { operator: email || claims.userId, verified: true };
}

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'bad JSON' }, 400); }

  const { agent, message, accessToken } = body || {};
  const base = AGENT_URL[agent];
  if (!base) return json({ ok: false, error: `unknown agent "${agent}"` }, 400);
  if (!message) return json({ ok: false, error: 'missing message' }, 400);

  let operator, verified;
  try {
    ({ operator, verified } = await resolveOperator(accessToken));
  } catch (e) {
    return json({ ok: false, reason: `login could not be verified: ${e.message}` }, 401);
  }

  let res;
  try {
    res = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sage-operator': operator },
      body: JSON.stringify({ message }),
    });
  } catch (e) {
    return json({ ok: false, reason: `agent unreachable: ${e.message}` }, 502);
  }

  const data = await res.json().catch(() => ({ ok: false, reason: 'agent returned non-JSON' }));
  // Surface whether the operator was cryptographically verified (dev vs prod).
  return json({ ...data, operator, verified }, res.status);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
