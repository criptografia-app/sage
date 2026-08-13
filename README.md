# SAGE — Agentic Wallet

> **S**afe + **AG**I + **E** — the wise agent that decides when to sign.
> *"Your agents. Your keys. Your rules."*

SAGE is an AI-native multisig wallet built on the [Safe](https://safe.global) protocol.
Instead of a wallet that waits for humans to sign, SAGE is a wallet that **thinks** — AI
agents hold co-signing keys, read the *real* pending transaction off the Safe
Transaction Service, apply a policy, and either co-sign autonomously or hold for a human.
You talk to it through [MCP](https://modelcontextprotocol.io).

SAGE is the **brain**; the raw Safe SDK work is the **body**. It never controls funds
alone — the Safe's threshold does.

---

## The one thing to understand first: SAGE is fail-closed

Out of the box, **SAGE auto-signs nothing.** Every pending transaction is held for a
human co-signature. This is deliberate, not unfinished:

- KYC/AML status is hard-coded to *un-verified* until a real `compliance.js` is wired.
- No price oracle is in scope, so a transaction's USD value is treated as **unknown**,
  and an unknown value **fails closed** — it can never slip under a limit.

Auto-signing only becomes possible once a human wires compliance + a price oracle and
explicitly relaxes those defaults. Until then, SAGE is a policy-aware *co-signer that
always defers to you.* That is the safe state to run it in.

---

## Architecture

```
        You (hardware wallet / MetaMask)         ← Owner 1
                     │
   ┌─────────────────┼─────────────────┐
   │        Safe Multisig (EVM)        │          on-chain, holds the funds
   │        threshold: 2-of-3          │
   └─────────────────┼─────────────────┘
                     │
   agent-compliance ─┘  ← Owner 2 (SAGE-managed key)
   agent-execution  ─┘  ← Owner 3 (SAGE-managed key)

   ┌───────────────────────────────────────────────────────────────┐
   │ SAGE (this repo) — the brain                                   │
   │                                                                │
   │  sage.js          MCP server (JSON-RPC/stdio) + CLI            │
   │  policyEngine.js  AUTO_SIGN / HOLD_HUMAN / REJECT              │
   │  safeClient.js    protocol-kit + api-kit (perception + action) │
   │  agentKey.js      AES-256-GCM encrypted agent keys             │
   └───────────────────────────────────────────────────────────────┘
                     │  reads ground truth from
                     ▼
        Safe Transaction Service (per chain)
```

- **No single key controls funds** — the Safe is a contract; no one acts alone.
- **Agents can't act alone either** — 2-of-3 means an agent signature is never enough on its own.
- **Talk to your wallet via Claude** — MCP-native; no MetaMask needed for routine signing.
- **Ground truth, not caller claims** — signing decisions are derived from the actual
  pending tx on the Transaction Service, never from arguments the caller passes in.
- **Every decision is audited** — append-only `sage-audit.log` + on-chain.

Complementary project: [`mcp-safe`](https://github.com/dennisonbertram/mcp-safe) handles
admin/query Safe ops (`get_info`, `get_balance`, `add_owner`…). Run it alongside SAGE for
manual operations; SAGE focuses on autonomous, policy-gated signing.

---

## How a signing decision is made

```
sage_approve(safe_tx_hash)
      │
      ▼
1. Fetch the REAL pending tx from the Safe Transaction Service
2. Decode it (native value, and any ERC-20 transfer in the calldata)
3. Build a TRUSTED context from those facts — caller-supplied context is ignored
      │
      ▼
policyEngine.evaluate(tx, context)
      │
      ├─ AML flag on address/amount ........................ REJECT
      ├─ value unverifiable, or > always_human ceiling ..... HOLD_HUMAN
      ├─ new/never-seen destination ........................ HOLD_HUMAN
      ├─ outside operating hours/days (BRT) ................ HOLD_HUMAN
      ├─ > auto-sign limit / KYC or AML not clear /
      │  token off the whitelist ........................... HOLD_HUMAN
      └─ all conditions met ................................ AUTO_SIGN
      │
      ▼
On AUTO_SIGN: protocol-kit rebuilds the exact pending tx, re-derives the
canonical EIP-712 SafeTx hash, REFUSES to sign if it ≠ the requested hash,
then submits the confirmation.
```

| Decision | When | Agent action |
|----------|------|-------------|
| `AUTO_SIGN`  | All policy conditions met on the real tx | Co-signs immediately |
| `HOLD_HUMAN` | Over limit / unknown value / off-hours / new address / KYC-AML unverified | Refuses to sign; you co-sign at [app.safe.global](https://app.safe.global) |
| `REJECT`     | AML flag active | Refuses and logs the reason |

---

## MCP Tools

Once SAGE is configured in Claude Desktop:

| You say | Tool | What happens |
|---------|------|--------------|
| *"what's pending in the wallet?"* | `sage_pending` | Lists txs awaiting signatures + who has signed |
| *"sign the 500 USDT trade"* | `sage_approve` | Derives facts from the real tx → policy → co-sign or hold |
| *"propose a transfer to 0xABC"* | `sage_propose` | Creates a pending tx in the Safe (others must co-sign) |
| *"show wallet state"* | `sage_info` | Owners, threshold, nonce, pending count |
| *"last 10 transactions"* | `sage_history` | Executed transaction history |
| *"show signing policy"* | `sage_policy` | Current auto-sign rules |

> `sage_approve` **ignores** any `context` you pass it (kyc/aml/value). Gating is
> derived from the real pending transaction — a caller cannot claim `value_usd: 10`
> for a large transfer to force an auto-sign.

---

## Quick Start

### 1. Install

```bash
git clone git@github.com:criptografia-app/sage.git
cd sage
npm install
```

### 2. One-shot setup wizard (recommended)

Generates both agent keys, adds them to the Safe as owners, and raises the threshold to
2-of-3 — all via protocol-kit (owner-management calls are `authorized`, so they must run
as Safe transactions, which the wizard does correctly).

```bash
node setup.js
```

You'll be prompted for a Safe-owner private key. **It is never written to disk** — it's
held in memory only for that run. Generated agent passphrases are written to
`.sage-passphrases.txt` (move them into your `.env`).

<details>
<summary>…or set up manually</summary>

```bash
# Generate agent keys (encrypted at rest)
node sage.js keygen compliance     # → prints 0xABC…
node sage.js keygen execution      # → prints 0xDEF…
```

Then create a Safe at [app.safe.global](https://app.safe.global) with three owners
(you + both agent addresses) and threshold **2-of-3**, and put the address in
`sage-config.json`:

```json
{ "chain": "polygon", "safe_address": "0xYOUR_SAFE_ADDRESS" }
```
</details>

### 3. Add to Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sage": {
      "command": "node",
      "args": ["/path/to/sage/sage.js"],
      "env": {
        "SAGE_SAFE_ADDRESS": "0xYOUR_SAFE_ADDRESS",
        "SAGE_PASSPHRASE_EXECUTION": "your-execution-passphrase",
        "SAGE_PASSPHRASE_COMPLIANCE": "your-compliance-passphrase"
      }
    }
  }
}
```

Restart Claude Desktop — the SAGE tools appear automatically.

### 4. …or run via Docker

```bash
cp .env.example .env      # fill in SAGE_SAFE_ADDRESS + passphrases
docker compose up -d
```

---

## Signing Policy

Configured in `sage-config.json` under `"policy"`, hot-reloaded on every evaluation:

```json
{
  "policy": {
    "auto_sign": {
      "max_value_usd":      3000,
      "allowed_tokens":     ["USDT", "USDC", "ETH", "BNB"],
      "requires_kyc":       true,
      "requires_aml_clear": true,
      "allowed_hours":      { "start": 9, "end": 18 },
      "allowed_days":       [1, 2, 3, 4, 5]
    },
    "always_human": {
      "above_usd":     10000,
      "new_address":   true,
      "aml_flagged":   true,
      "outside_hours": true
    }
  }
}
```

Notes on the semantics the test suite pins down:

- **Operating hours are BRT (UTC−3).** The window is start-inclusive / end-exclusive:
  `[09:00, 18:00)`. Days are `0=Sun … 6=Sat`; default is Mon–Fri.
- **Value fails closed.** A missing or non-finite `value_usd` is *not* “under the limit” —
  it forces `HOLD_HUMAN`.
- `always_human` is checked before `auto_sign`; an `aml_flagged` context is a hard `REJECT`.

---

## CLI

```bash
node sage.js                   # start the MCP server (JSON-RPC over stdio)
node sage.js keygen <name>     # generate + encrypt an agent key
node sage.js pending           # list pending Safe transactions
node sage.js info              # Safe state summary (owners, threshold, nonce)
node setup.js                  # one-shot: keys → owners → 2-of-3 threshold
```

Importing `sage.js` as a module (for `deriveTrustedContext` / `resolveSafeAddress`) does
**not** start the server — the entry point is guarded by an invoked-directly check.

---

## Supported Chains

| Chain | `chain` value | RPC default (override via env) | Transaction Service |
|-------|---------------|--------------------------------|---------------------|
| Polygon  | `polygon`  | `POLYGON_RPC` → `polygon-bor-rpc.publicnode.com` | safe-transaction-polygon.safe.global |
| Base     | `base`     | `BASE_RPC` → `mainnet.base.org` | safe-transaction-base.safe.global |
| Ethereum | `ethereum` | `ETH_RPC` → `eth.llamarpc.com` | safe-transaction-mainnet.safe.global |
| Sepolia  | `sepolia`  | `SEPOLIA_RPC` → `ethereum-sepolia-rpc.publicnode.com` | safe-transaction-sepolia.safe.global |

> The old `polygon-rpc.com` and `rpc.sepolia.org` defaults are dead (401 / Cloudflare
> errors) and were replaced with keyless, live public nodes. Env vars still override.

Primary wallet: Polygon Safe `0xe601D7B4103FD508dA521A25D7639F085448196d`.

---

## Agent keys

Each agent key is a plain EOA — it becomes powerful only once added as a Safe owner.
Keys are stored encrypted at rest with **AES-256-GCM + scrypt** (`N=16384, r=8, p=1`),
each blob carrying its own salt, IV, and auth tag:

```
.sage-key-compliance.enc    ← never commit
.sage-key-execution.enc     ← never commit
```

Both are gitignored. Back them up securely (encrypted USB, password manager). The
passphrase is never written to disk; it's supplied via `SAGE_PASSPHRASE_<AGENT>` env vars.

---

## Correctness (TOKEN-67)

SAGE's signing path and its policy gate were hardened and locked with offline tests. The
bugs that were found and fixed:

| # | Where | Bug | Fix |
|---|-------|-----|-----|
| 1 | `safeClient.js` | Co-signing used `signMessage` (EIP-191 `personal_sign`, v=27/28) over the tx hash — rejected by Safe owners, who need an EIP-712 SafeTx signature. | Delegate to `@safe-global/protocol-kit` for canonical EIP-712 hashing + signature encoding. |
| 2 | `safeClient.js` | `proposeTransaction` hand-rolled `safeTxHash` as `keccak256(abiEncode(...))`, omitting the EIP-712 domain separator (chainId + Safe address) and using raw `data`. Wrong hash → wrong signature. | protocol-kit produces the hash; `signTransaction` rebuilds the exact pending tx and **refuses to sign** if its derived hash ≠ the requested one. |
| 3 | `sage.js` | `sage_approve` fed **caller-supplied** context straight into the policy engine — a caller could claim `value_usd: 10` for a large transfer and auto-sign. | Derive all policy inputs from the real pending tx; caller context is ignored. KYC/AML default to un-verified (fail-closed). |
| 4 | `policyEngine.js` | `getUTCHours() - 3` underflowed below 03:00 UTC (e.g. 01:00 UTC → −2), silently breaking the operating-hours check. | `((getUTCHours() - 3) + 24) % 24` keeps it in 0–23. |
| 5 | `sage.js` | The startup banner resolved the Safe env-first while every tool resolved config-first — SAGE could **report** one Safe and **operate** on another. | Single `resolveSafeAddress()` source of truth for banner + tools. |
| 6 | `policyEngine.js` | An unverifiable `value_usd` (`undefined > limit` is `false`) silently satisfied every ceiling and would reach `AUTO_SIGN` the moment KYC/AML were wired true. | Value gate **fails closed**: unknown/non-finite value → `HOLD_HUMAN`. |

---

## Tests

Offline, network-free, timezone-independent. No keys, no funds.

```bash
npm test        # runs every test/*.mjs via `node --test`
```

| Suite | Locks in |
|-------|----------|
| `hash-conformance.mjs` | protocol-kit's SafeTx hash == an independent ethers reference; the old hand-rolled hash and EIP-191 digest differ (Bugs 1 & 2). |
| `policy-engine.mjs` | The full decision table + BRT operating-hours edges + the Bug 4 clock regression. |
| `policy-value-failclosed.mjs` | Unknown/NaN/negative value → `HOLD_HUMAN`; known under-limit → `AUTO_SIGN` (Bug 6). |
| `fail-closed.mjs` | Fed real tx facts, the engine **never** auto-signs while compliance is unwired. |
| `safe-address-resolution.mjs` | Reported Safe can't diverge from the operated Safe (Bug 5). |
| `sdk-interop.mjs` | The CJS/ESM `.default` interop for protocol-kit / api-kit resolves to callable classes. |

---

## Security model

| Threat | Mitigation |
|--------|-----------|
| Compromised agent key | Revoke that owner via another owner; the 2-of-3 threshold still protects funds. |
| Policy bypass via crafted args | Decisions derive from the real on-chain pending tx; caller context is ignored. |
| Wrong-tx signing | `signTransaction` re-derives the EIP-712 hash and refuses if it ≠ the requested hash. |
| Agent acting alone | Threshold 2-of-3 — an agent signature alone is never enough. |
| Server compromise | Agent keys are AES-256-GCM encrypted at rest; passphrase never stored on disk. |
| Auto-signing on unverified facts | Fail-closed: KYC/AML default un-verified and unknown value holds — nothing auto-signs until compliance is wired. |
| AML violation | `REJECT` — the agent refuses and logs. |

---

## Roadmap to "going live" (auto-signing)

SAGE holds every transaction today by design. Flipping it to autonomous signing is a
series of **human-gated** steps — an agent must not cross these alone:

1. Wire `compliance.js` (KYC/AML) from the P2P repo — cross-repo follow-up.
2. Wire a price oracle so `value_usd` is real (never synthesised).
3. Add the real agent keys as Safe owners + set 2-of-3 (`node setup.js`) — needs a funded
   deployer and human co-signers.
4. Deploy / authorize on-chain on the Polygon Safe.

Only then does relaxing the fail-closed defaults make sense — and that's an explicit human
decision, backed by the audit log and the test suite above.

---

## Integration with CRIPTOGRAFIA P2P Desk

When a trade is confirmed at the OTC desk (`POST /api/confirm`), the intended flow is:
propose a Safe transfer to the customer → agent-compliance runs KYC/AML → if within
policy, agent-execution co-signs → 2-of-3 reached → Safe executes → receipt updated with
the on-chain tx hash. See [CRIPTO-181](https://linear.app/criptografia/issue/CRIPTO-181).

---

## Layout

```
sage/
├── sage.js           MCP server (JSON-RPC/stdio) + CLI + trusted-context builder
├── safeClient.js     Safe Transaction Service wrapper (perception + action)
├── policyEngine.js   AUTO_SIGN / HOLD_HUMAN / REJECT
├── agentKey.js       Encrypted agent-key management (AES-256-GCM + scrypt)
├── setup.js          One-shot wizard: keys → owners → 2-of-3 threshold
├── sage-config.json  Chain, Safe address, policy rules
├── test/             Offline conformance + policy + fail-closed suites
├── Dockerfile · docker-compose.yml · .env.example
```

---

## Tickets

| Ticket | Topic |
|--------|-------|
| [TOKEN-67](https://linear.app/criptografia/issue/TOKEN-67) | Signing correctness + policy-bypass fixes (this branch) |
| [CRIPTO-177](https://linear.app/criptografia/issue/CRIPTO-177) | Safe deployment (testnet → Polygon) |
| [CRIPTO-178](https://linear.app/criptografia/issue/CRIPTO-178) | Safe SDK integration |
| [CRIPTO-179](https://linear.app/criptografia/issue/CRIPTO-179) | Policy engine |
| [CRIPTO-180](https://linear.app/criptografia/issue/CRIPTO-180) | MCP server tools |
| [CRIPTO-181](https://linear.app/criptografia/issue/CRIPTO-181) | P2P desk integration |
| [CRIPTO-182](https://linear.app/criptografia/issue/CRIPTO-182) | Daemon + monitoring |

---

## License

MIT — CRIPTOGRAFIA Capital.
Built on [Safe{Core}](https://safe.global) · Powered by [Claude MCP](https://modelcontextprotocol.io)
