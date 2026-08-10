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
import { fileURLToPath }            from 'url';
import readline                     from 'readline';
import { SAGEClient }               from './safeClient.js';
import { generateAgentKey, loadAgentSigner } from './agentKey.js';
import { evaluate, DECISION }       from './policyEngine.js';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Config ─────────────────────────────────────────────────────────────────
function loadConfig() {
  const cfgPath = join(__dir, 'sage-config.json');
  if (!existsSync(cfgPath)) return {};
  return JSON.parse(readFileSync(cfgPath, 'utf8'));
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
function deriveTrustedContext(details) {
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
];

// ── Tool handlers ────────────────────────────────────────────────────────────
async function handleTool(name, args) {
  const cfg    = loadConfig();
  const chain  = cfg.chain || 'polygon';
  const safe   = cfg.safe_address || process.env.SAGE_SAFE_ADDRESS;

  if (!safe && !['sage_policy'].includes(name)) {
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
      const pass = process.env[`SAGE_PASSPHRASE_${agent.toUpperCase()}`];
      if (!pass) return { error: `Set env var SAGE_PASSPHRASE_${agent.toUpperCase()} to unlock this agent's key.` };

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

      // Auto-sign
      const signer = loadAgentSigner(agent, pass, client.provider);
      const result = await client.signTransaction(safe_tx_hash, signer);
      auditLog({ action: 'signed', safe_tx_hash, agent, signer: signer.address });
      return { ...result, decision, reasons };
    }

    case 'sage_propose': {
      const { to, value = '0', data = '0x', agent = 'execution' } = args;
      const pass = process.env[`SAGE_PASSPHRASE_${agent.toUpperCase()}`];
      if (!pass) return { error: `Set env var SAGE_PASSPHRASE_${agent.toUpperCase()} to unlock this agent's key.` };

      const signer = loadAgentSigner(agent, pass, client.provider);
      const result = await client.proposeTransaction({ to, value, data }, signer);
      auditLog({ action: 'proposed', agent, signer: signer.address, to, value });
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
    const client = new SAGEClient(cfg.chain || 'polygon', cfg.safe_address || process.env.SAGE_SAFE_ADDRESS);
    const result = await handleTool('sage_pending', {});
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'info') {
    const cfg    = loadConfig();
    const client = new SAGEClient(cfg.chain || 'polygon', cfg.safe_address || process.env.SAGE_SAFE_ADDRESS);
    const result = await handleTool('sage_info', {});
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

  console.error('[SAGE] MCP server running on stdio. Wallet: ' +
    (process.env.SAGE_SAFE_ADDRESS || loadConfig().safe_address || '(not configured)'));
}

// ── Entry point ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.length > 0) {
  runCLI(argv).catch(e => { console.error(e); process.exit(1); });
} else {
  startMCPServer();
}
