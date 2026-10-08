import { PUBLIC_ROSTER } from '../../agents/roster';

// The roster the UI renders (no internal URLs). Runtime-driven by AGENTS_JSON.
export async function GET() {
  return new Response(JSON.stringify({ agents: PUBLIC_ROSTER }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
