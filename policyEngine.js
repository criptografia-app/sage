/**
 * SAGE — Policy Engine
 *
 * Decides whether an agent should auto-sign a pending Safe transaction
 * or hold for human co-signature.
 *
 * Policy is loaded from sage-config.json and can be hot-reloaded.
 *
 * ── Threat model (TOKEN-67 hardening) ──────────────────────────────────────
 * `context` is caller-supplied, so it is hostile: whatever drives the MCP tool
 * (an LLM, in practice) chooses every field. The engine therefore FAILS CLOSED
 * — an input it cannot positively verify is not a reason to sign, it is a
 * reason to hold. AUTO_SIGN is returned only when every gate was satisfied by
 * a value of the right shape. Concretely:
 *   • gates read OWN properties only, so a polluted `Object.prototype` (or a
 *     context built with `Object.create`) cannot assert KYC on their behalf;
 *   • verification booleans must be exactly `true` — a truthy `'no'` is not a
 *     KYC pass, and only an explicit `is_new_address: false` clears that gate;
 *   • `value_usd` must be a finite, non-negative number — `undefined`, `NaN`
 *     and `'abc'` all made the `>` limit comparisons false, which auto-signed
 *     an unbounded amount;
 *   • `token` must be an explicitly whitelisted symbol (case-sensitive);
 *   • the agent's role must declare the `approve` capability;
 *   • the policy object is normalised against DEFAULT_POLICY, so a missing or
 *     mistyped config field cannot silently delete a limit;
 *   • anything unexpected — bad shape, a throw — resolves to HOLD_HUMAN.
 * Widening any of this is a policy decision, not a bug fix.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

function loadPolicy() {
  try {
    return normalizePolicy(
      JSON.parse(readFileSync(join(__dir, 'sage-config.json'), 'utf8')).policy,
    );
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

// ── Untrusted-input helpers ─────────────────────────────────────────────────

/** Read an OWN property. Inherited/polluted prototype claims read as absent. */
function own(obj, key) {
  return obj !== null && typeof obj === 'object' && Object.hasOwn(obj, key)
    ? obj[key]
    : undefined;
}

/** A USD amount we are willing to compare against a limit. */
function isVerifiedAmount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** Short, safe rendering of an untrusted value for the reasons[] audit trail. */
function describe(v) {
  if (typeof v === 'number') return String(v);   // 42, NaN, Infinity, -5
  if (v === null) return 'null';
  return typeof v;                               // undefined, string, object, …
}

/**
 * Coerce a config-supplied policy into the full shape, field by field, taking
 * DEFAULT_POLICY for anything missing or of the wrong type. Without this, a
 * config that merely omits `max_value_usd` turns every `value > limit` check
 * into `value > undefined` (always false) and removes the ceiling entirely.
 * Exported for tests.
 */
export function normalizePolicy(raw) {
  const obj  = (v) => (v !== null && typeof v === 'object' ? v : {});
  const num  = (v, fb) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
  const bool = (v, fb) => (typeof v === 'boolean' ? v : fb);
  const list = (v, fb) => (Array.isArray(v) ? v : fb);

  const policy = obj(raw);
  const auto   = obj(policy.auto_sign);
  const human  = obj(policy.always_human);
  const roles  = obj(policy.agent_roles);
  const hours  = obj(auto.allowed_hours);

  const dAuto  = DEFAULT_POLICY.auto_sign;
  const dHuman = DEFAULT_POLICY.always_human;

  return {
    auto_sign: {
      max_value_usd:      num(auto.max_value_usd, dAuto.max_value_usd),
      allowed_tokens:     list(auto.allowed_tokens, dAuto.allowed_tokens),
      requires_kyc:       bool(auto.requires_kyc, dAuto.requires_kyc),
      requires_aml_clear: bool(auto.requires_aml_clear, dAuto.requires_aml_clear),
      allowed_hours: {
        start: num(hours.start, dAuto.allowed_hours.start),
        end:   num(hours.end,   dAuto.allowed_hours.end),
      },
      allowed_days:       list(auto.allowed_days, dAuto.allowed_days),
    },
    always_human: {
      above_usd:     num(human.above_usd, dHuman.above_usd),
      new_address:   bool(human.new_address, dHuman.new_address),
      aml_flagged:   bool(human.aml_flagged, dHuman.aml_flagged),
      outside_hours: bool(human.outside_hours, dHuman.outside_hours),
    },
    // sage-config.json ships no agent_roles; fall back to the declared defaults
    // rather than leaving the capability check with nothing to read.
    agent_roles: Object.keys(roles).length > 0 ? roles : DEFAULT_POLICY.agent_roles,
  };
}

// ── Decision types ──────────────────────────────────────────────────────────
export const DECISION = {
  AUTO_SIGN:     'AUTO_SIGN',      // agent signs immediately
  HOLD_HUMAN:    'HOLD_HUMAN',     // needs human co-signature
  REJECT:        'REJECT',         // agent actively rejects
};

/**
 * Evaluate whether an agent should sign a pending Safe transaction.
 *
 * Never throws: a gate that crashes is not a gate, so any unexpected error
 * resolves to HOLD_HUMAN.
 *
 * @param {object} tx         - the decoded transaction proposal
 * @param {object} context    - { kyc_verified, aml_clear, value_usd, token, is_new_address }
 * @param {string} agentRole  - 'compliance' | 'execution'
 * @returns {{ decision: string, reasons: string[] }}
 */
export function evaluate(tx, context, agentRole = 'execution') {
  try {
    return decide(tx, context, agentRole);
  } catch (err) {
    return {
      decision: DECISION.HOLD_HUMAN,
      reasons:  [`policy evaluation failed: ${err.message}`],
    };
  }
}

function decide(tx, context, agentRole) {
  const policy  = loadPolicy();
  const auto    = policy.auto_sign;
  const human   = policy.always_human;
  const reasons = [];

  // A non-object context carries no verifiable claims at all.
  if (context === null || typeof context !== 'object') {
    return {
      decision: DECISION.HOLD_HUMAN,
      reasons:  [`no verifiable context supplied (got ${describe(context)})`],
    };
  }

  // ── Hard rejects ────────────────────────────────────────────────────────
  // Any truthy flag rejects — this is the one gate where a sloppy value is
  // safe to honour, because honouring it refuses to sign.
  if (own(context, 'aml_flagged')) {
    return { decision: DECISION.REJECT, reasons: ['AML flag on address or amount'] };
  }

  // ── Always require human ─────────────────────────────────────────────────
  const valueUsd = own(context, 'value_usd');
  if (!isVerifiedAmount(valueUsd)) {
    reasons.push(`value_usd is not a verified amount (got ${describe(valueUsd)})`);
  } else if (valueUsd > human.above_usd) {
    reasons.push(`value USD ${valueUsd} > limit ${human.above_usd}`);
  }
  const isNewAddress = own(context, 'is_new_address');
  if (human.new_address && isNewAddress !== false) {
    reasons.push(isNewAddress === true
      ? 'destination address never seen before'
      : 'destination address not verified as previously seen');
  }
  const now  = new Date();
  // BRT = UTC-3. The old `getUTCHours() - 3` underflowed to negative values
  // before 03:00 UTC (e.g. 01:00 UTC → -2), silently breaking the comparison.
  // The `+ 24) % 24` keeps it in 0–23. (getDay() is still machine-local — a
  // separate BRT-day seam tracked as an out-of-scope follow-up.)
  const hour = ((now.getUTCHours() - 3) + 24) % 24;
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
  // Past this point valueUsd is a verified finite non-negative number.
  const roleName = typeof agentRole === 'string' ? agentRole : describe(agentRole);
  const capabilities = typeof agentRole === 'string'
    ? own(policy.agent_roles, agentRole)
    : undefined;
  if (!Array.isArray(capabilities) || !capabilities.includes('approve')) {
    return {
      decision: DECISION.HOLD_HUMAN,
      reasons:  [`agent role ${roleName} is not authorised to approve`],
    };
  }
  if (valueUsd > auto.max_value_usd) {
    return {
      decision: DECISION.HOLD_HUMAN,
      reasons:  [`value USD ${valueUsd} > auto-sign limit ${auto.max_value_usd}`],
    };
  }
  if (auto.requires_kyc && own(context, 'kyc_verified') !== true) {
    return { decision: DECISION.HOLD_HUMAN, reasons: ['KYC not verified'] };
  }
  if (auto.requires_aml_clear && own(context, 'aml_clear') !== true) {
    return { decision: DECISION.HOLD_HUMAN, reasons: ['AML check not passed'] };
  }
  const token = own(context, 'token');
  if (typeof token !== 'string' || !auto.allowed_tokens.includes(token)) {
    return {
      decision: DECISION.HOLD_HUMAN,
      reasons:  [`token ${typeof token === 'string' ? token : describe(token)} not in auto-sign whitelist`],
    };
  }

  return { decision: DECISION.AUTO_SIGN, reasons: ['all policy conditions met'] };
}
