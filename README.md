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

## The financial team: `/proposal` and `/signer`

SAGE runs as a **team of two agents plus you**, each agent a Claude skill in its
own container holding only its own key — so an agent literally *cannot* act
outside its role:

```
Authenticated owner (Privy / email)
   │  "/proposal  send 500 USDC to Acme and 200 to vitalik.eth"
   ▼
/proposal  (container: proposal/compliance key only)
   │  resolves recipients (name / ENS / #number / address), proposes each,
   │  adds signature #1 — never executes
   ▼   you review the pending page (names + ENS, not raw hex)
   │  "/signer  approve all I just checked"
   ▼
/signer    (container: execution key only)
   │  adds signature #2 → 2-of-3 reached → executes
   ▼   bulk but INDEPENDENT — one failing tx never aborts the rest
```

### Authorization model — "2 agents + your OK"

The two agent signatures satisfy the 2-of-3 threshold; **your key never signs
on-chain.** Instead, your **authenticated instruction is the human
co-signature.** This is what makes it hands-free without being unguarded:

- **Identity is the gate.** `/signer` refuses without an authenticated operator
  (`SAGE_OPERATOR` — the owner's email, via Privy in production). Identity ties to
  the Safe.
- **Every approval is accountable.** The operator who authorized a batch is
  recorded in `sage-audit.log` for every signature — including any case where the
  operator's OK *overrode* a policy `HOLD_HUMAN`. That override is deliberate (you
  reviewed it) and always traceable to you.
- **Hard `REJECT` is never overridden in bulk.** An AML-flagged tx is surfaced to
  be handled one at a time, not swept along by "approve all".
- **Container isolation** means a compromised proposal agent can propose but can
  never co-sign to threshold, and vice-versa.

> This is a distinct, explicitly-operator-authorized path — separate from the
> autonomous, fail-closed `sage_approve`. It does **not** reopen the caller-context
> bypass closed in TOKEN-67: policy still evaluates on the *real* on-chain tx; the
> operator's authenticated identity, not caller-supplied facts, is what authorizes.

Execution is **bulk but independent**: `/signer` signs every approved tx and
executes each on its own nonce; one failure is reported and skipped, never
reverting the others. (An atomic MultiSend batch is a roadmap option.)

### Hardware 2FA on the human authorization layer

The owner's authorization can be hardened with a **physical second factor** — a
touch on a **Trezor** or a **YubiKey** — cryptographically **bound to the exact
batch** being approved. When the operator has a registered device, `/signer`
refuses to sign without a fresh, valid proof (fail-closed).

- **Trezor / hardware wallet** — an **EIP-712** signature over the authorization
  struct `{ operator, safeTxHashes (sorted), nonce, issuedAt, expiresAt }`,
  verified by address recovery.
- **YubiKey / FIDO2** — a **WebAuthn P-256 assertion** over a challenge that binds
  the same struct, verified with Node crypto (no external dependency) — checks the
  challenge, the user-presence flag, and the signature.
- **Bound, fresh, one-shot** — a proof authorizes *one* batch (its exact hash set),
  within a short **TTL**, and its **nonce is burned** on use, so it can never be
  replayed or retargeted at a different batch.

Registered devices live in `authz-devices.json` (public keys/addresses only — no
secrets; see `authz-devices.example.json`).

> **Threat model — this is an off-chain gate.** It hardens the *instruction
> channel*: a stolen session or a spoofed instruction can't authorize without the
> physical device. It does **not** defend a fully compromised signing-agent *host*
> (which holds the execution key and could bypass a software gate). For that
> stronger guarantee, register the hardware device as a **real Safe owner** so the
> on-chain threshold itself requires the device — tracked as a roadmap option.

---

## Address book & ENS

You approve **names**, not 40 hex characters you can't eyeball — a safety win as
much as a UX one.

- **Address book** (`address-book.json`) — saved recipients referable by
  **name** ("Acme Corp"), **number** ("#5"), or exact/unique-prefix match.
  *"Open the address book"* → `sage_address_book` returns the numbered list.
- **ENS everywhere** — a recipient can be an **ENS name** ("vitalik.eth"), resolved
  forward at propose time (on Ethereum mainnet, regardless of the Safe's chain,
  via `ENS_RPC`/`ETH_RPC`). Addresses are **reverse-resolved** to their ENS name
  for display where one exists (best-effort — a flaky RPC just omits it).
- **Fail loud, never wrong.** An ambiguous or unresolvable reference **aborts** the
  proposal (and aborts the *whole* batch) rather than sending funds to a
  silently-wrong address.

Resolution order: literal `0x` address → ENS name → book number → book name.

---

## MCP Tools

Once SAGE is configured in Claude Desktop:

| You say | Tool | What happens |
|---------|------|--------------|
| *"open the address book"* | `sage_address_book` | Lists saved recipients (numbered; ENS-decorated) |
| *"propose transfers to Acme and vitalik.eth"* | `sage_propose_batch` | Proposal agent proposes many txs at once (first signature each) |
| *"propose a transfer to #5"* | `sage_propose` | Proposes one tx; recipient resolved by name / ENS / number / address |
| *"signer, approve all I've checked"* | `sage_approve_all` | Signing agent co-signs every pending tx + executes those at threshold |
| *"what's pending in the wallet?"* | `sage_pending` | Lists txs awaiting signatures + who has signed |
| *"sign the 500 USDT trade"* | `sage_approve` | Derives facts from the real tx → policy → co-sign or hold (single, autonomous) |
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
node sage.js propose-batch '<json-array>'   # proposal agent: propose many txs (or via stdin)
SAGE_OPERATOR=you@corp.com node sage.js approve-all   # signing agent: co-sign + execute pending
node setup.js                  # one-shot: keys → owners → 2-of-3 threshold
```

The `/proposal` and `/signer` **skills** (in `.claude/skills/`) wrap these so an
operator just types `/proposal …` or `/signer approve all`. Each is meant to run
in its own container with only that agent's passphrase in the environment.

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
| `batch-ops.mjs` | The team money path (mock client): operator required; bulk-but-independent; HOLD override is recorded; REJECT not overridden; no double-signing; executes only at threshold. |
| `address-book.mjs` | Recipient resolution: address / index / name / unique-prefix / ambiguity errors; ENS forward + best-effort reverse (mock provider). |
| `authz.mjs` | Hardware 2FA with real crypto: Trezor EIP-712 (ethers) + YubiKey WebAuthn P-256 (Node crypto); batch-binding, TTL, replay, device-type + presence checks. |
| `remote-signer.mjs` | Keyless signing: valid owner sig from a `signDigest`-only backend; v-normalization; refuses a signature that doesn't recover to the owner; HTTP vault backend (mock fetch) incl. wrong-key + error paths. |

---

## Keyless signing (Warden / Vault)

An agent never has to hold a private key. When a signature is needed, the agent
computes the canonical Safe **EIP-712 hash locally**, then makes a **request to a
vault** (Warden / HashiCorp Vault Transit / a KMS) that holds the key and returns
**only a signature**. The key never enters the agent process.

- **`signer.js`** — `RemoteSigner` over a pluggable backend that exposes only
  `signDigest(digest) → { r, s }`. Backends: `local` (in-memory key — dev / SAGE
  free tier only), and `http` / `warden` / `vault` (generic `POST { keyRef, digest }
  → { r, s }`).
- **Verified before submit** — `RemoteSigner` **refuses** any returned signature
  that does not recover to the expected owner address, so a wrong or compromised
  vault key can never be silently submitted.
- **`safeClient.signTransactionKeyless()`** — derives the exact canonical hash
  (via protocol-kit's pure `generateTypedData`, identical to the
  hash-conformance vector), checks it against the requested `safeTxHash`, then
  delegates signing to the vault.

This works in **both SAGE and PRIVATE**. Configure it per agent under `keys` in
`sage-config.json` — with no `keys` entry, SAGE uses the local encrypted key as
before (nothing changes):

```json
{
  "keys": {
    "execution": {
      "backend":  "warden",
      "address":  "0xAgentOwnerAddress",
      "endpoint": "https://your-vault/sign",
      "keyRef":   "agents/execution",
      "headers":  { "authorization": "Bearer ${VAULT_TOKEN}" }
    }
  }
}
```

`endpoint` / `keyRef` / header values support `${ENV}` placeholders. In SAGE free,
omit `keys` and keep the local encrypted keystore; in **PRIVATE**, every agent is
keyless by policy (see `PRIVATE/ARCHITECTURE-secrets.md`).

---

## Inference & pricing (BYOK or hosted)

SAGE is **MCP-first** — every capability is an agent tool — and the inference that
drives the agents is a configurable layer (`inference.js`), so SAGE stays free and
sovereign while offering a paid convenience path:

- **BYOK (free)** — bring your own provider API key (`anthropic` / `openai` /
  `openrouter`); SAGE surfaces the **selectable models** for that key so you pick
  one. Nothing routes through us; SAGE stays sovereign.
- **Hosted ($/mo)** — CRIPTOGRAFIA sells the inference on a subscription; requests
  route through the SAGE gateway, gated by a license token.

MCP tools: `sage_inference` (current mode / model / usable?) and `sage_models`
(the menu for a provider). Config lives under `inference` in `sage-config.json`;
env overrides: `SAGE_INFERENCE_MODE`, `SAGE_INFERENCE_PROVIDER`,
`SAGE_INFERENCE_MODEL`, the provider key env, and `SAGE_LICENSE`.

> **CRIPTOGRAFIA PRIVATE** — the full agentic private-bank / wealth-management
> stack — is a *separate, premium* product (bespoke onboarding, compliance,
> reporting, recovery, fiat bridges, TEE, dedicated support). SAGE free is the
> sovereign funnel; PRIVATE is the white-glove tier.

---

## Security model

| Threat | Mitigation |
|--------|-----------|
| Compromised agent key | Revoke that owner via another owner; the 2-of-3 threshold still protects funds. |
| Policy bypass via crafted args | Decisions derive from the real on-chain pending tx; caller context is ignored. |
| Wrong-tx signing | `signTransaction` re-derives the EIP-712 hash and refuses if it ≠ the requested hash. |
| Agent acting alone | Threshold 2-of-3 — an agent signature alone is never enough. |
| Server compromise | Agent keys are AES-256-GCM encrypted at rest; passphrase never stored on disk. **Keyless mode:** the key can live entirely in a vault (Warden / Vault) so it never enters the agent — a popped host can request signatures (still policy + 2FA gated) but cannot steal the key. |
| Wrong / compromised vault key | `RemoteSigner` verifies the returned signature recovers to the expected owner and refuses otherwise. |
| Auto-signing on unverified facts | Fail-closed: KYC/AML default un-verified and unknown value holds — nothing auto-signs until compliance is wired. |
| AML violation | `REJECT` — the agent refuses and logs; not overridable in a bulk approval. |
| Unauthenticated batch approval | `sage_approve_all` refuses without an operator identity; every approval (and any HOLD override) is logged against that operator. |
| One agent compromised | Each agent runs in its own container with only its key; it can reach one signature, never the 2-of-3 threshold alone. |
| Stolen session / spoofed "approve" instruction | Optional hardware 2FA (Trezor EIP-712 / YubiKey WebAuthn) bound to the exact batch, fresh (TTL) and one-shot (nonce burned) — `/signer` refuses without a valid proof. |
| Funds sent to a wrong/typo'd recipient | Names/ENS are resolved and shown back; an ambiguous or unresolvable reference aborts the (whole) proposal rather than guessing. |

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

### Also on the roadmap

- **Privy auth** — real verified-email identity as the operator principal (today
  the operator is the authenticated MCP/CLI session; the seam is already in place).
- **Per-agent containers** — ship `/proposal` and `/signer` as isolated container
  services, each with only its own key.
- **Voice** — an opt-in toggle for spoken interaction: the wallet reads back what
  it's about to propose/sign and confirms out loud. Client-layer (TTS/STT); the
  signing engine is unchanged.
- **Hardware device as an on-chain Safe owner** — the stronger form of the 2FA
  above: register the Trezor/YubiKey as a real threshold signer, so no host
  compromise can move funds without the physical device.
- **Atomic MultiSend** — an option to bundle an approved batch into a single
  all-or-nothing Safe transaction (today: bulk-but-independent execution).

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
├── safeClient.js     Safe Transaction Service wrapper — perceive / sign / execute
├── policyEngine.js   AUTO_SIGN / HOLD_HUMAN / REJECT
├── batchOps.js       Team workflow: proposeBatch + approveAll (bulk, independent)
├── authz.js          Hardware 2FA authorization — Trezor EIP-712 + YubiKey WebAuthn
├── signer.js         Keyless remote signing — RemoteSigner over Warden / Vault backends
├── addressBook.js    Recipient resolution — name / number / ENS (fwd + reverse)
├── address-book.json Saved recipients
├── agentKey.js       Encrypted agent-key management (AES-256-GCM + scrypt)
├── setup.js          One-shot wizard: keys → owners → 2-of-3 threshold
├── sage-config.json  Chain, Safe address, policy rules
├── .claude/skills/   /proposal and /signer agent skills
├── test/             Offline suites (policy, fail-closed, batch, address book, hash)
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
