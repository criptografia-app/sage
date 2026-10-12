/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SAGE — the agentic wallet for Safe multisig.
 *  A product of CRIPTOGRAFIA CAPITAL, and the foundation of
 *  CRIPTOGRAFIA PRIVATE (Non-Custodial Agentic Wealth Management).
 *
 *  Copyright (c) 2026 CRIPTOGRAFIA Capital.
 *  Released under the MIT License. Free, sovereign, bring-your-own-key.
 *
 *  NON-CUSTODIAL. CRIPTOGRAFIA Capital never takes custody of your assets.
 *  Funds are held solely by your own Safe multisig smart contract. Agent keys
 *  are yours: encrypted at rest locally, or held in a vault you control. You
 *  can always recover and operate your Safe with no vendor present. This
 *  software creates no custodial relationship.
 *
 *  FAIL-CLOSED BY DESIGN. Agents propose; they do not unilaterally move funds.
 *  Execution requires the Safe's threshold of signatures plus the owner's
 *  authenticated instruction. Any unknown, stale, unverifiable or
 *  out-of-policy fact must resolve to HOLD, never to proceed. Do not modify
 *  this file in a way that weakens that guarantee.
 *
 *  NO WARRANTY; NOT FINANCIAL, LEGAL OR TAX ADVICE. Provided "AS IS", without
 *  warranty of any kind, express or implied. Distributed-ledger transactions
 *  are irreversible and may result in total loss of funds. You are solely
 *  responsible for your own regulatory, KYC/AML, sanctions and tax
 *  obligations. See LICENSE for the full terms.
 * ═══════════════════════════════════════════════════════════════════════════
 */
/**
 * SAGE — Agent chat (natural language → tools)
 *
 * Turns a user message into agent action by running an inference tool-use loop
 * over the SAGE MCP tools the agent's role is allowed to use. This is what lets
 * the web frontend "talk to the bots": the publisher/signer HTTP services call
 * runAgentChat() with their role's toolset and a callTool() bound to handleTool.
 *
 * Design:
 *   - Inference config comes from inference.js (BYOK/hosted), so which model and
 *     who pays is a config change, not a code change.
 *   - callTool is INJECTED, so this module never imports sage.js (no cycle) and
 *     stays unit-testable with a fake tool executor.
 *   - Fails soft: if inference isn't configured, it returns a clear reason
 *     instead of throwing, so the service and UI can guide the user to add a key.
 *
 * POC scope: the Anthropic Messages API tool-use loop is implemented. Other
 * providers resolve/validate through inference.js but the chat loop returns a
 * "not wired yet" reason for them — a deliberate, visible boundary.
 */
import { inferenceStatus, PROVIDERS } from './inference.js';

/** Map SAGE MCP tool defs → Anthropic tool schema. */
export function toAnthropicTools(tools) {
  return tools.map(t => ({
    name:         t.name,
    description:  t.description,
    input_schema: t.inputSchema || { type: 'object', properties: {} },
  }));
}

/**
 * Run one chat turn: let the model reason and call the role's tools until it
 * produces a final text answer (or hits maxSteps).
 *
 * @param {object}   o
 * @param {string}   o.message   - the user's natural-language instruction
 * @param {string}   o.system    - role system prompt (who this agent is + limits)
 * @param {object[]} o.tools     - SAGE MCP tool defs the role may use
 * @param {(name:string,input:object)=>Promise<any>} o.callTool - executes a tool
 * @param {object}   [o.cfg]     - sage-config.json (for inference resolution)
 * @param {object}   [o.env]     - process.env (injected for tests)
 * @param {number}   [o.maxSteps]
 * @returns {Promise<{ok:boolean, reply?:string, reason?:string, tools_used?:object[], steps?:number, inference?:object}>}
 */
export async function runAgentChat({ message, system, tools, callTool, cfg = {}, env = process.env, maxSteps = 6 }) {
  const status = inferenceStatus(cfg, env);
  if (!status.usable) {
    return { ok: false, reason: status.reason || 'inference not configured', inference: status };
  }
  if (status.provider !== 'anthropic') {
    return { ok: false, reason: `chat is wired for Anthropic in this POC; configured provider is "${status.provider}"`, inference: status };
  }

  const apiKey = (cfg.inference && cfg.inference.apiKey) || env[PROVIDERS.anthropic.keyEnv];
  const endpoint = (cfg.inference && cfg.inference.endpoint) || PROVIDERS.anthropic.endpoint;
  const model    = status.model;
  const atools   = toAnthropicTools(tools);

  const messages = [{ role: 'user', content: message }];
  const toolLog  = [];

  for (let step = 0; step < maxSteps; step++) {
    let res;
    try {
      res = await fetch(endpoint + '/v1/messages', {
        method:  'POST',
        headers: {
          'content-type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model, max_tokens: 1024, system, tools: atools, messages }),
      });
    } catch (e) {
      return { ok: false, reason: `inference request failed: ${e.message}`, inference: status };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, reason: `inference HTTP ${res.status}: ${body.slice(0, 300)}`, inference: status };
    }

    const data = await res.json();
    messages.push({ role: 'assistant', content: data.content });

    const toolUses = (data.content || []).filter(c => c.type === 'tool_use');
    if (toolUses.length === 0) {
      const reply = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
      return { ok: true, reply, tools_used: toolLog, steps: step + 1 };
    }

    // Execute each requested tool and feed the results back for the next step.
    const results = [];
    for (const tu of toolUses) {
      let output;
      try { output = await callTool(tu.name, tu.input || {}); }
      catch (e) { output = { error: e.message }; }
      toolLog.push({ name: tu.name, input: tu.input, output });
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(output) });
    }
    messages.push({ role: 'user', content: results });
  }

  return { ok: true, reply: '(reached the maximum number of reasoning steps)', tools_used: toolLog, steps: maxSteps };
}
