/**
 * SAGE — Policy Engine
 *
 * Decides whether an agent should auto-sign a pending Safe transaction
 * or hold for human co-signature.
 *
 * Policy is loaded from sage-config.json and can be hot-reloaded.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

function loadPolicy() {
  try {
    return JSON.parse(readFileSync(join(__dir, 'sage-config.json'), 'utf8')).policy;
  } catch {
    return DEFAULT_POLICY;
  }
}

const DEFAULT_POLICY = {
  auto_sign: {
    max_value_usd:    3000,
    allowed_tokens:   ['USDT', 'USDC', 'ETH', 'BNB'],
    requires_kyc:     true,
    requires_aml_clear: true,
    allowed_hours:    { start: 9, end: 18 },
    allowed_days:     [1, 2, 3, 4, 5],   // Mon–Fri
  },
  always_human: {
    above_usd:        10000,
    new_address:      true,
    aml_flagged:      true,
    outside_hours:    true,
  },
  agent_roles: {
    compliance: ['check_kyc', 'check_aml', 'reject'],
    execution:  ['approve', 'reject'],
  },
};

// ── Decision types ──────────────────────────────────────────────────────────
export const DECISION = {
  AUTO_SIGN:     'AUTO_SIGN',      // agent signs immediately
  HOLD_HUMAN:    'HOLD_HUMAN',     // needs human co-signature
  REJECT:        'REJECT',         // agent actively rejects
};

/**
 * Evaluate whether an agent should sign a pending Safe transaction.
 *
 * @param {object} tx         - the decoded transaction proposal
 * @param {object} context    - { kyc_verified, aml_clear, value_usd, token, is_new_address }
 * @param {string} agentRole  - 'compliance' | 'execution'
 * @returns {{ decision: string, reasons: string[] }}
 */
export function evaluate(tx, context, agentRole = 'execution') {
  const policy  = loadPolicy();
  const auto    = policy.auto_sign;
  const human   = policy.always_human;
  const reasons = [];

  // ── Hard rejects ────────────────────────────────────────────────────────
  if (context.aml_flagged) {
    return { decision: DECISION.REJECT, reasons: ['AML flag on address or amount'] };
  }

  // ── Always require human ─────────────────────────────────────────────────
  if (context.value_usd > human.above_usd) {
    reasons.push(`value USD ${context.value_usd} > limit ${human.above_usd}`);
  }
  if (context.is_new_address && human.new_address) {
    reasons.push('destination address never seen before');
  }
  const now  = new Date();
  const hour = now.getUTCHours() - 3; // BRT = UTC-3
  const day  = now.getDay();
  const outOfHours = hour < auto.allowed_hours.start || hour >= auto.allowed_hours.end;
  const outOfDays  = !auto.allowed_days.includes(day);
  if (outOfHours || outOfDays) {
    reasons.push(`outside operating hours (${hour}h BRT, day ${day})`);
  }

  if (reasons.length > 0) {
    return { decision: DECISION.HOLD_HUMAN, reasons };
  }

  // ── Auto-sign conditions ─────────────────────────────────────────────────
  if (context.value_usd > auto.max_value_usd) {
    return {
      decision: DECISION.HOLD_HUMAN,
      reasons:  [`value USD ${context.value_usd} > auto-sign limit ${auto.max_value_usd}`],
    };
  }
  if (auto.requires_kyc && !context.kyc_verified) {
    return { decision: DECISION.HOLD_HUMAN, reasons: ['KYC not verified'] };
  }
  if (auto.requires_aml_clear && !context.aml_clear) {
    return { decision: DECISION.HOLD_HUMAN, reasons: ['AML check not passed'] };
  }
  if (context.token && !auto.allowed_tokens.includes(context.token)) {
    return {
      decision: DECISION.HOLD_HUMAN,
      reasons:  [`token ${context.token} not in auto-sign whitelist`],
    };
  }

  return { decision: DECISION.AUTO_SIGN, reasons: ['all policy conditions met'] };
}
