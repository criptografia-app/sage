// The agent roster the frontend offers and the API route proxies to. Driven by
// the AGENTS_JSON env (set by the PRIVATE compose to the full team; unset falls
// back to the two SAGE agents). Server-side only — the `url`s are in-network
// service names and must never reach the browser.
const DEFAULT = [
  { id: 'publisher', label: 'Publisher', blurb: 'proposes transactions', url: process.env.PUBLISHER_URL || 'http://localhost:3010' },
  { id: 'signer',    label: 'Signer',    blurb: 'co-signs / executes',    url: process.env.SIGNER_URL    || 'http://localhost:3011' },
];

function load() {
  if (!process.env.AGENTS_JSON) return DEFAULT;
  try {
    const parsed = JSON.parse(process.env.AGENTS_JSON);
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch { /* fall back on malformed config */ }
  return DEFAULT;
}

export const ROSTER = load();

// Public view for the browser — never expose the internal `url`.
export const PUBLIC_ROSTER = ROSTER.map(({ id, label, blurb }) => ({ id, label, blurb }));
