#!/usr/bin/env node
/**
 * SAGE — Agentic Wallet
 * Safe + AGI signing layer via MCP
 *
 * "Your agents. Your keys. Your rules."
 *
 * The wallet is the agent.
 * It perceives blockchain state, applies policy, acts autonomously,
 * and communicates via MCP with the operator.
 *
 * Usage:
 *   node sage.js                  — start MCP server
 *   node sage.js keygen <name>    — generate encrypted agent key
 *   node sage.js pending          — list pending Safe transactions
 *   node sage.js info             — show Safe state summary
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname }            from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import readline                     from 'readline';
import { ethers }                   from 'ethers';
import { SAGEClient, CHAINS }       from './safeClient.js';
import { generateAgentKey, loadAgentSigner } from './agentKey.js';
import { evaluate, DECISION }       from './policyEngine.js';
import { proposeBatch, approveAll } from './batchOps.js';
import { listContacts, resolveRecipientAsync, reverseEns } from './addressBook.js';
import { makeAuthorizer } from './authz.js';
import { inferenceStatus, listModels } from './inference.js';
import { makeSigner } from './signer.js';

// ── Keyless signing resolver ──────────────────────────────────────────────────
// When an agent is configured with a remote key backend (Warden / Vault), no
// private key ever lives in this process — signing is a request to the vault.
// Config lives under `keys` in sage-config.json, e.g.
//   "keys": { "execution": { "backend": "warden", "address": "0x..",
//                            "endpoint": "https://vault/sign", "keyRef": "agent/exec" } }
// keyRef/endpoint may use ${ENV} placeholders resolved from the environment.
function resolveEnvPlaceholders(v) {
  return typeof v === 'string'
    ? v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => process.env[k] ?? '')
    : v;
}
function keylessSignerFor(agent, cfg) {
  const spec = cfg.keys && cfg.keys[agent];
  if (!spec || spec.backend === 'local') return null;   // no remote backend → use local encrypted key
  const headers = spec.headers ? Object.fromEntries(
    Object.entries(spec.headers).map(([k, v]) => [k, resolveEnvPlaceholders(v)])) : {};
  return makeSigner({
    ...spec,
    endpoint: resolveEnvPlaceholders(spec.endpoint),
    keyRef:   resolveEnvPlaceholders(spec.keyRef),
    headers,
  });
}

// ── Hardware-2FA device registry ──────────────────────────────────────────────
// Maps an operator identity (email) → their registered 2FA device. Kept in
// authz-devices.json (gitignored — it holds public keys/addresses, no secrets,
// but it's deployment-specific). A shared nonce store belongs here in production;
// the in-memory default is per-process.
function loadAuthzDevices() {
  const p = join(__dir, 'authz-devices.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
}
const deviceFor = (operator) => loadAuthzDevices()[operator] || null;
const authorizer = makeAuthorizer(deviceFor);

// ENS lives on Ethereum mainnet regardless of which chain the Safe is on, so ENS
// resolution always goes through a mainnet provider (ENS_RPC / ETH_RPC override).
// Lazily created so nothing pays for it unless an ENS name is actually used.
let _ensProvider = null;
function ensProvider() {
  if (!_ensProvider) {
    _ensProvider = new ethers.JsonRpcProvider(process.env.ENS_RPC || CHAINS.ethereum.rpc);
  }
  return _ensProvider;
}

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Config ─────────────────────────────────────────────────────────────────
function loadConfig() {
  const cfgPath = join(__dir, 'sage-config.json');
  if (!existsSync(cfgPath)) return {};
  return JSON.parse(readFileSync(cfgPath, 'utf8'));
}

/**
 * Resolve the Safe this wallet operates on. SINGLE SOURCE OF TRUTH.
 *
 * The startup banner and every tool call MUST resolve the Safe through this one
 * function, so what SAGE *reports* can never diverge from what it *signs
 * against*. They used to differ: the banner resolved env-first while every tool
 * resolved config-first. With SAGE_SAFE_ADDRESS pointing at a testnet Safe, SAGE
 * printed the testnet address and then operated on the configured mainnet Safe —
 * the guard an operator would reach for to protect themselves reported success
 * while doing the opposite.
 *
 * Precedence is deliberately UNCHANGED (config first): that is what the tools
 * have always done, so routing the banner through it is a reporting fix with
 * zero behaviour change. Which source *should* win is a separate, explicit
 * decision and is not being smuggled in here.
 */
export function resolveSafeAddress(cfg = loadConfig()) {
  return cfg.safe_address || process.env.SAGE_SAFE_ADDRESS || null;
}

// ── Audit log ───────────────────────────────────────────────────────────────
import { appendFileSync } from 'fs';
function auditLog(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  appendFileSync(join(__dir, 'sage-audit.log'), line + '\n');
  if (process.env.NODE_ENV !== 'test') console.error('[SAGE AUDIT]', line);
}

// ── Trusted policy context ────────────────────────────────────────────────────
/**
 * Build the policy context from the REAL pending tx, never from caller args.
 *
 * KYC/AML status and a USD valuation are not available inside this repo yet —
 * wiring them from P2P's compliance.js (and a price oracle) is a separate,
 * design-gated follow-up. Until then we default the compliance flags to the
 * un-verified (safe) side, so the policy engine holds every tx for a human
 * co-signature rather than auto-signing on facts we cannot verify.
 *
 * @param {object} details - output of SAGEClient.getTransactionDetails()
 */
export function deriveTrustedContext(details) {
  return {
    // Real, tx-derived facts (from the Transaction Service / calldata):
    to:              details.to,
    value_wei:       details.value,
    token_address:   details.erc20?.token_address ?? null,
    transfer_amount: details.erc20?.transfer_amount ?? null,
    // Compliance facts we cannot verify in-scope. NOT caller-supplied.
    // Default to the side that forces HOLD_HUMAN until compliance.js is wired.
    kyc_verified:    false,
    aml_clear:       false,
    // value_usd deliberately omitted: no price oracle in-scope, and we must not
    // synthesise a value that could let a large transfer slip under a limit.
  };
}

// ── MCP Server — JSON-RPC over stdio ────────────────────────────────────────
// SAGE exposes itself as an MCP server so Claude/any MCP client can control it.

const TOOLS = [
  {
    name: 'sage_info',
    description: 'Get the current state of the SAGE agentic wallet — balance, owners, threshold, recent activity.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'sage_pending',
    description: 'List all Safe transactions currently pending signatures. Shows who has signed and how many are still needed.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'sage_approve',
    description: 'Approve (co-sign) a pending Safe transaction as the SAGE agent. The policy engine evaluates whether to auto-sign or refuse.',
    inputSchema: {
      type: 'object',
      required: ['safe_tx_hash'],
      properties: {
        safe_tx_hash: { type: 'string', description: 'The safeTxHash of the pending transaction' },
        agent:        { type: 'string', description: 'Agent name to sign with (default: execution)', default: 'execution' },
        context:      { type: 'object', description: 'Ignored for signing decisions. Auto-sign gating is derived from the real pending tx, not from caller-supplied context.' },
      },
    },
  },
  {
    name: 'sage_propose',
    description: 'Propose a new transaction to the Safe (e.g. send tokens, call a contract). Other owners must co-sign before it executes.',
    inputSchema: {
      type: 'object',
      required: ['to', 'value'],
      properties: {
        to:    { type: 'string', description: 'Destination address' },
        value: { type: 'string', description: 'Value in wei (0 for contract calls)' },
        data:  { type: 'string', description: 'Calldata hex (optional, default 0x)' },
        agent: { type: 'string', description: 'Agent proposing the tx (default: execution)' },
      },
    },
  },
  {
    name: 'sage_address_book',
    description: 'PROPOSAL AGENT: list the saved recipients ("open address book"). Returns a numbered list of name → address so you can say "send to #5" or "send to Acme".',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'sage_propose_batch',
    description: 'PROPOSAL AGENT: propose many transactions to the Safe at once, each carrying the agent\'s first signature. Returns a safeTxHash per proposed tx.',
    inputSchema: {
      type: 'object',
      required: ['transactions'],
      properties: {
        transactions: {
          type: 'array',
          description: 'List of { to, value, data } to propose',
          items: {
            type: 'object',
            required: ['to'],
            properties: {
              to:    { type: 'string', description: 'Destination address' },
              value: { type: 'string', description: 'Value in wei (default 0)' },
              data:  { type: 'string', description: 'Calldata hex (default 0x)' },
            },
          },
        },
        agent:    { type: 'string', description: 'Proposing agent (default: compliance)' },
        operator: { type: 'string', description: 'Authenticated owner identity (email) authorising the batch — recorded for audit.' },
      },
    },
  },
  {
    name: 'sage_approve_all',
    description: 'SIGNING AGENT: on the authenticated owner\'s instruction ("approve all I\'ve checked"), add the agent\'s signature to every pending tx and execute those that reach threshold. Bulk but independent — one failure does not abort the rest.',
    inputSchema: {
      type: 'object',
      required: ['operator'],
      properties: {
        operator: { type: 'string', description: 'Authenticated owner identity (email). REQUIRED — this instruction is the human co-signature and is recorded for audit.' },
        agent:    { type: 'string', description: 'Signing agent (default: execution)' },
        only:     { type: 'array', items: { type: 'string' }, description: 'Optional allow-list of safeTxHashes to act on (default: all pending).' },
        execute:  { type: 'boolean', description: 'Execute txs that reach threshold after signing (default true).' },
        authorization: { type: 'object', description: 'Hardware 2FA proof (Trezor EIP-712 or YubiKey/WebAuthn) bound to this batch. Required when the operator has a registered 2FA device.' },
      },
    },
  },
  {
    name: 'sage_history',
    description: 'Get the last N executed transactions from this Safe.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of transactions to return (default 10)' },
      },
    },
  },
  {
    name: 'sage_policy',
    description: 'Read the current signing policy — what the agents auto-sign vs what requires human approval.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'sage_inference',
    description: 'Show the inference setup: hosted (CRIPTOGRAFIA subscription) or BYOK (your own API key), which model, whether it is usable, and the models you can select.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'sage_models',
    description: 'List the models available for an inference provider (anthropic / openai / openrouter) — the menu to pick from once a key is entered.',
    inputSchema: {
      type: 'object',
      properties: { provider: { type: 'string', description: 'anthropic | openai | openrouter (default: the configured provider)' } },
    },
  },
];

// ── Tool handlers ────────────────────────────────────────────────────────────
async function handleTool(name, args) {
  const cfg    = loadConfig();
  const chain  = cfg.chain || 'polygon';
  const safe   = resolveSafeAddress(cfg);

  if (!safe && !['sage_policy', 'sage_address_book', 'sage_inference', 'sage_models'].includes(name)) {
    return { error: 'SAGE_SAFE_ADDRESS not set. Add it to sage-config.json or export SAGE_SAFE_ADDRESS.' };
  }

  const client = safe ? new SAGEClient(chain, safe) : null;

  switch (name) {

    case 'sage_info': {
      const summary = await client.summarise();
      return {
        wallet:   summary.safe,
        chain:    summary.chain,
        owners:   summary.info?.owners || [],
        threshold:`${summary.info?.threshold || '?'}-of-${summary.info?.owners?.length || '?'}`,
        nonce:    summary.info?.nonce,
        pending_count: summary.pending.length,
        recent_txs:    summary.recent.length,
      };
    }

    case 'sage_pending': {
      const pending = await client.getPendingTransactions();
      if (pending.length === 0) return { message: 'No transactions pending signature.', pending: [] };
      return {
        count: pending.length,
        transactions: pending.map(tx => ({
          safeTxHash:    tx.safeTxHash,
          to:            tx.to,
          value_eth:     tx.valuEth,
          confirmations: `${tx.confirmations}/${tx.confirmationsRequired}`,
          proposed_by:   tx.proposedBy,
          submitted:     tx.submissionDate,
        })),
      };
    }

    case 'sage_approve': {
      const { safe_tx_hash, agent = 'execution' } = args;

      // Keyless path: if this agent has a remote key backend (Warden / Vault),
      // no private key lives here — we don't need a passphrase to unlock one.
      const keyless = keylessSignerFor(agent, cfg);
      const pass = process.env[`SAGE_PASSPHRASE_${agent.toUpperCase()}`];
      if (!keyless && !pass) return { error: `Set env var SAGE_PASSPHRASE_${agent.toUpperCase()} to unlock this agent's key (or configure keys.${agent} for a remote vault backend).` };

      // SECURITY: never gate auto-signing on caller-supplied context. Any
      // kyc_verified / aml_clear / value_usd the caller passes in `args` is
      // ignored — a caller could claim `value_usd: 10` for a large transfer.
      // We derive the decision inputs from the real pending tx on the
      // Transaction Service instead.
      const details = await client.getTransactionDetails(safe_tx_hash);
      const context = deriveTrustedContext(details);

      // Policy check against tx-derived facts.
      const { decision, reasons } = evaluate(details, context, agent);
      auditLog({ action: 'policy_eval', safe_tx_hash, agent, decision, reasons, context });

      if (decision === DECISION.REJECT) {
        return { signed: false, decision, reasons };
      }
      if (decision === DECISION.HOLD_HUMAN) {
        return { signed: false, decision, reasons, message: 'Transaction held — human co-signature required.' };
      }

      // Auto-sign. Keyless (vault) if configured, else the local encrypted key.
      let result;
      if (keyless) {
        result = await client.signTransactionKeyless(safe_tx_hash, keyless);
        auditLog({ action: 'signed', safe_tx_hash, agent, signer: keyless.getAddress(), keyless: true });
      } else {
        const signer = loadAgentSigner(agent, pass, client.provider);
        result = await client.signTransaction(safe_tx_hash, signer);
        auditLog({ action: 'signed', safe_tx_hash, agent, signer: signer.address });
      }
      return { ...result, decision, reasons };
    }

    case 'sage_address_book': {
      const contacts = listContacts();
      if (contacts.length === 0) return { message: 'Address book empty. Add contacts to address-book.json.', contacts: [] };
      // Best-effort reverse ENS so the popup shows a name where one exists.
      // Never blocks the listing — a flaky RPC just leaves `ens: null`.
      const withEns = await Promise.all(contacts.map(async c => ({
        ...c, ens: await reverseEns(c.address, ensProvider()),
      })));
      return { count: withEns.length, contacts: withEns };
    }

    case 'sage_propose': {
      const { to, value = '0', data = '0x', agent = 'execution' } = args;
      const pass = process.env[`SAGE_PASSPHRASE_${agent.toUpperCase()}`];
      if (!pass) return { error: `Set env var SAGE_PASSPHRASE_${agent.toUpperCase()} to unlock this agent's key.` };

      // Resolve `to`: accepts a literal address, an ENS name ("acme.eth"), a book
      // number ("5"), or a saved name ("Acme"). Fails loudly on no/ambiguous
      // match so funds never go to a silently-wrong recipient.
      let recipient;
      try { recipient = await resolveRecipientAsync(to, { provider: ensProvider() }); }
      catch (e) { return { error: e.message }; }

      const signer = loadAgentSigner(agent, pass, client.provider);
      const result = await client.proposeTransaction({ to: recipient.address, value, data }, signer);
      auditLog({ action: 'proposed', agent, signer: signer.address, to: recipient.address, to_name: recipient.name, value });
      return { ...result, recipient };
    }

    case 'sage_propose_batch': {
      const { transactions, agent = 'compliance', operator = process.env.SAGE_OPERATOR } = args;
      const pass = process.env[`SAGE_PASSPHRASE_${agent.toUpperCase()}`];
      if (!pass) return { error: `Set env var SAGE_PASSPHRASE_${agent.toUpperCase()} to unlock this agent's key.` };

      // Resolve every recipient BEFORE proposing anything (addresses, ENS names,
      // book numbers/names) — a typo'd/ambiguous/unresolvable name aborts the
      // whole batch rather than proposing a partial or wrong set.
      let resolved;
      try {
        resolved = await Promise.all((transactions || []).map(async t => {
          const r = await resolveRecipientAsync(t.to, { provider: ensProvider() });
          return { ...t, to: r.address, to_name: r.name };
        }));
      } catch (e) { return { error: e.message }; }

      const signer = loadAgentSigner(agent, pass, client.provider);
      const result = await proposeBatch(client, signer, resolved, { operator });
      auditLog({ action: 'proposed_batch', agent, signer: signer.address, operator, count: result.count, summary: result.summary });
      return result;
    }

    case 'sage_approve_all': {
      const { agent = 'execution', only = null, execute = true, operator = process.env.SAGE_OPERATOR, authorization = null } = args;
      if (!operator) return { error: 'operator identity required — pass `operator` (authenticated owner email) or set SAGE_OPERATOR. A batch approval must be authorised by an authenticated owner.' };
      const pass = process.env[`SAGE_PASSPHRASE_${agent.toUpperCase()}`];
      if (!pass) return { error: `Set env var SAGE_PASSPHRASE_${agent.toUpperCase()} to unlock this agent's key.` };

      // Hardware 2FA: enforced when the operator has a registered device or the
      // policy demands it. Fail-closed — a registered operator can't skip 2FA by
      // omitting the proof (missing proof fails verification and refuses the batch).
      const require2fa = !!deviceFor(operator) || !!(cfg.policy && cfg.policy.require_2fa);
      const gate = require2fa ? { authorize: authorizer, proof: authorization } : {};

      const signer = loadAgentSigner(agent, pass, client.provider);
      const result = await approveAll(client, signer, { operator, only, execute, ...gate });
      auditLog({ action: 'approve_all', agent, signer: signer.address, operator, count: result.count, summary: result.summary,
                 // record the per-tx outcome so an override is always traceable to the authorising owner
                 results: result.results.map(r => ({ safeTxHash: r.safeTxHash, status: r.status, policy: r.policy, overrode_hold: r.overrode_hold })) });
      return result;
    }

    case 'sage_history': {
      const limit = args.limit || 10;
      const history = await client.getHistory(limit);
      return { count: history.length, transactions: history };
    }

    case 'sage_policy': {
      const cfg = loadConfig();
      return cfg.policy || { message: 'No policy configured. Add "policy" to sage-config.json.' };
    }

    case 'sage_inference': {
      return inferenceStatus(loadConfig(), process.env);
    }

    case 'sage_models': {
      const provider = args.provider || loadConfig().inference?.provider || process.env.SAGE_INFERENCE_PROVIDER || 'anthropic';
      try { return { provider, models: listModels(provider) }; }
      catch (e) { return { error: e.message }; }
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── CLI commands ─────────────────────────────────────────────────────────────
async function runCLI(argv) {
  const [cmd, ...rest] = argv;

  if (cmd === 'keygen') {
    const agentName = rest[0];
    if (!agentName) { console.error('Usage: node sage.js keygen <agent-name>'); process.exit(1); }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`Passphrase for agent "${agentName}": `, pass => {
      rl.close();
      generateAgentKey(agentName, pass);
    });
    return;
  }

  if (cmd === 'pending') {
    const cfg    = loadConfig();
    const client = new SAGEClient(cfg.chain || 'polygon', resolveSafeAddress(cfg));
    const result = await handleTool('sage_pending', {});
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'info') {
    const cfg    = loadConfig();
    const client = new SAGEClient(cfg.chain || 'polygon', resolveSafeAddress(cfg));
    const result = await handleTool('sage_info', {});
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Signing agent: `node sage.js approve-all` — authorised by SAGE_OPERATOR.
  // Powers the `/signer` skill. Operator identity comes from the env so the
  // authenticated owner is bound to the session, not passed on the command line.
  if (cmd === 'approve-all') {
    const result = await handleTool('sage_approve_all', {
      agent:    process.env.SAGE_AGENT || 'execution',
      operator: process.env.SAGE_OPERATOR,
      execute:  process.env.SAGE_NO_EXECUTE ? false : true,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Proposal agent: `node sage.js propose-batch '<json-array>'` (or via stdin).
  // Powers the `/proposal` skill. JSON is a list of { to, value, data }.
  if (cmd === 'propose-batch') {
    const raw = rest[0] || readFileSync(0, 'utf8');   // fd 0 = stdin when no arg
    let transactions;
    try { transactions = JSON.parse(raw); }
    catch { console.error('propose-batch: expected a JSON array of { to, value, data }'); process.exit(1); }
    const result = await handleTool('sage_propose_batch', {
      transactions,
      agent:    process.env.SAGE_AGENT || 'compliance',
      operator: process.env.SAGE_OPERATOR,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Default: MCP JSON-RPC server over stdio
  startMCPServer();
}

// ── MCP server (JSON-RPC 2.0 over stdio) ─────────────────────────────────────
function startMCPServer() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  const respond = (id, result) => {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  };
  const respondErr = (id, code, message) => {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
  };

  rl.on('line', async line => {
    let req;
    try { req = JSON.parse(line); } catch { return; }
    const { id, method, params } = req;

    try {
      if (method === 'initialize') {
        respond(id, {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'sage', version: '0.1.0' },
          capabilities: { tools: {} },
        });
      } else if (method === 'tools/list') {
        respond(id, { tools: TOOLS });
      } else if (method === 'tools/call') {
        const result = await handleTool(params.name, params.arguments || {});
        respond(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      } else {
        respondErr(id, -32601, `Method not found: ${method}`);
      }
    } catch (e) {
      respondErr(id, -32000, e.message);
    }
  });

  // Reports the SAME resolution the tools operate on — see resolveSafeAddress().
  console.error('[SAGE] MCP server running on stdio. Wallet: ' +
    (resolveSafeAddress() || '(not configured)'));
}

// ── Entry point ───────────────────────────────────────────────────────────────
// Only run as a program when invoked directly (`node sage.js ...`). When this
// module is imported (e.g. by the test suite to reach deriveTrustedContext /
// resolveSafeAddress), skip the entry point — otherwise a bare import would
// silently start the MCP server and block on stdin.
const invokedDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  if (argv.length > 0) {
    runCLI(argv).catch(e => { console.error(e); process.exit(1); });
  } else {
    startMCPServer();
  }
}
