# SAGE web — social login → talk to your agents

A Next.js + [Privy](https://privy.io) frontend. A user signs in with a social
login; that identity becomes the **operator** the SAGE agents already require for
signing actions. From the chat UI you talk to two bots:

- **publisher** — the proposal agent (proposes txs; never executes)
- **signer** — the signing agent (co-signs/executes on your instruction, within policy)

## How auth flows

```
Browser ──login──▶ Privy ──access token──▶ /api/chat (server)
                                              │ verifyAuthToken()  ← trust boundary
                                              ▼ x-sage-operator: <you>
                                   sage-publisher / sage-signer  ──▶ Safe
```

The browser can **not** pick its own `operator`: the API route derives it from a
verified Privy token. Without `PRIVY_APP_SECRET` it falls back to a marked
`dev@local` identity so the stack runs locally — that path must never ship.

## Run (via the stack)

From the repo root:

```bash
# set NEXT_PUBLIC_PRIVY_APP_ID / PRIVY_APP_ID / PRIVY_APP_SECRET (see web/.env.example)
docker compose build sage-web
docker compose up -d sage-publisher sage-signer sage-web
open http://localhost:8080
```

## Run (dev)

```bash
cd web && npm install && npm run dev    # http://localhost:3000
# point at locally-running agents:
#   node ../sage.js serve publisher   (:3010)
#   node ../sage.js serve signer      (:3011)
```

## Notes

- The `/chat` endpoint needs inference configured on the agent side
  (`ANTHROPIC_API_KEY` for BYOK). Without it the agent returns a clear
  "add a key" message rather than failing.
- Privy SDK versions in `package.json` are a starting point — run `npm install`
  to lock, and bump if the Privy dashboard shows a newer major.
