# SAGE — Agentic Wallet

> **S**afe + **AG**I + **E** — the wise agent that decides when to sign.
> *"Your agents. Your keys. Your rules."*

SAGE is an AI-native multisig wallet built on the [Safe](https://safe.global) protocol.
Instead of a wallet that waits for humans to sign, SAGE is a wallet that **thinks** —
AI agents hold co-signing keys, monitor pending transactions, apply policy, and act autonomously via MCP.

---

## What it is

```
[Safe Multisig Contract — EVM]
       │
       ├── Owner 1: You          (hardware wallet / MetaMask)
       ├── Owner 2: agent-compliance  (SAGE-managed key)
       └── Owner 3: agent-execution   (SAGE-managed key)
       threshold: 2-of-3

[MCP Interface]
       │
       └── "sign what's pending" → agent evaluates policy → co-signs → Safe executes
```

- **No single key controls funds** — Safe is a contract; no one acts alone.
- **Agents can't act alone either** — threshold always requires your co-signature on critical ops.
- **Talk to your wallet via Claude** — MCP-native, no MetaMask needed for routine signing.
- **Every decision is audited** — on-chain + `sage-audit.log`.

---

## MCP Tools

Once SAGE is configured in Claude Desktop, you can:

| You say | What happens |
|---------|-------------|
| *"what's pending in the wallet?"* | `sage_pending` → lists transactions awaiting signatures |
| *"sign the 500 USDT trade"* | `sage_approve` → policy engine evaluates → agent co-signs |
| *"hold the 15k one, it's above limit"* | `sage_approve` → HOLD_HUMAN → "requires your signature at app.safe.global" |
| *"propose a transfer to 0xABC"* | `sage_propose` → creates pending tx in Safe |
| *"show wallet state"* | `sage_info` → owners, threshold, balance, pending count |
| *"show signing policy"* | `sage_policy` → current auto-sign rules |

---

## Quick Start

### 1. Install

```bash
git clone git@github.com:criptografia-app/sage.git
cd sage
npm install
```

### 2. Generate agent keys

```bash
node sage.js keygen compliance
# Enter passphrase: ••••••••
# [SAGE] Agent key generated: compliance → 0xABC...

node sage.js keygen execution
# Enter passphrase: ••••••••
# [SAGE] Agent key generated: execution → 0xDEF...
```

### 3. Deploy a Safe

Go to [app.safe.global](https://app.safe.global) and create a new Safe with:
- Owner 1: your MetaMask address
- Owner 2: the `compliance` agent address (printed above)
- Owner 3: the `execution` agent address (printed above)
- Threshold: **2 of 3**

Copy the deployed Safe address into `sage-config.json`:

```json
{
  "chain": "polygon",
  "safe_address": "0xYOUR_SAFE_ADDRESS_HERE"
}
```

### 4. Add to Claude Desktop

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

Restart Claude Desktop. SAGE tools appear automatically.

### 5. Or run via Docker

```bash
cp .env.example .env
# fill in SAGE_SAFE_ADDRESS and passphrases
docker compose up -d
```

---

## Signing Policy

Configured in `sage-config.json` under `"policy"`. Hot-reloaded on every evaluation.

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
      "above_usd":    10000,
      "new_address":  true,
      "aml_flagged":  true
    }
  }
}
```

### Decision outcomes

| Decision | When | Agent action |
|----------|------|-------------|
| `AUTO_SIGN` | All conditions met | Signs immediately |
| `HOLD_HUMAN` | Above limit / off-hours / new address | Notifies you via WhatsApp/Telegram |
| `REJECT` | AML flag active | Refuses and logs reason |

---

## Architecture

```
sage/
├── sage.js           MCP server + CLI entry point
├── safeClient.js     Safe Transaction Service wrapper (perception + action)
├── agentKey.js       Encrypted agent key management (AES-256-GCM + scrypt)
├── policyEngine.js   Signing policy engine
├── sage-config.json  Chain, Safe address, policy rules
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

### Agent keys

Keys are stored encrypted at rest using AES-256-GCM with scrypt key derivation.
The pattern mirrors Safe's own key storage conventions.

```
.sage-key-compliance.enc   ← never commit this
.sage-key-execution.enc    ← never commit this
```

Both files are in `.gitignore`. Back them up securely (encrypted USB, password manager).

---

## CLI Commands

```bash
node sage.js                        # start MCP server (stdio)
node sage.js keygen <name>          # generate + encrypt agent key
node sage.js pending                # list pending Safe transactions
node sage.js info                   # show Safe state summary
node sage.js daemon                 # 24/7 monitoring mode (coming: CRIPTO-182)
```

---

## Supported Chains

| Chain | `chain` value | Safe Transaction Service |
|-------|--------------|--------------------------|
| Polygon | `polygon` | safe-transaction-polygon.safe.global |
| Base | `base` | safe-transaction-base.safe.global |
| Ethereum | `ethereum` | safe-transaction-mainnet.safe.global |
| Sepolia (testnet) | `sepolia` | safe-transaction-sepolia.safe.global |

---

## Integration with CRIPTOGRAFIA P2P Desk

When a trade is confirmed at the OTC desk (`POST /api/confirm`), SAGE automatically:
1. Proposes a Safe transaction to send tokens to the customer's address
2. Agent-compliance runs KYC/AML check
3. If within policy: agent-execution co-signs
4. 2-of-3 threshold reached → Safe executes on-chain
5. Receipt updated with on-chain tx hash

See [CRIPTO-181](https://linear.app/criptografia/issue/CRIPTO-181) for implementation details.

---

## Security model

| Threat | Mitigation |
|--------|-----------|
| Compromised agent key | Revoke that owner from the Safe via another owner. Threshold still protected. |
| Agent signing policy bypass | Policy is evaluated before every sign. Audit log is append-only. |
| Agent acting alone | Threshold 2-of-3. Agent-only = 1 signature = not enough. |
| Server compromise | Keys are encrypted at rest. Passphrase never stored on disk. |
| AML violation | REJECT decision — agent refuses to sign + logs. |

---

## Tickets

| Ticket | Topic |
|--------|-------|
| [CRIPTO-177](https://linear.app/criptografia/issue/CRIPTO-177) | Safe deployment (testnet → Polygon) |
| [CRIPTO-178](https://linear.app/criptografia/issue/CRIPTO-178) | Safe SDK integration |
| [CRIPTO-179](https://linear.app/criptografia/issue/CRIPTO-179) | Policy engine |
| [CRIPTO-180](https://linear.app/criptografia/issue/CRIPTO-180) | MCP server tools |
| [CRIPTO-181](https://linear.app/criptografia/issue/CRIPTO-181) | P2P desk integration |
| [CRIPTO-182](https://linear.app/criptografia/issue/CRIPTO-182) | Daemon + monitoring |
| [TOKEN-67](https://linear.app/criptografia/issue/TOKEN-67) | Parent concept ticket |

---

## License

MIT — CRIPTOGRAFIA Capital, 2024.
Built on [Safe{Core}](https://safe.global) · Powered by [Claude MCP](https://modelcontextprotocol.io)
