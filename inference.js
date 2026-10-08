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
 * SAGE — Inference layer (how the agents think, and who pays for it)
 *
 * Two monetization paths, one abstraction:
 *
 *   hosted  — CRIPTOGRAFIA sells the inference on a monthly fee. Requests route
 *             through the SAGE gateway, gated by a license/subscription token.
 *
 *   byok    — the user runs SAGE for free with their OWN provider API key, and
 *             selects any model that key unlocks. Nothing routes through us.
 *
 * The rest of SAGE (and the future private-bank agents) resolve inference through
 * `resolveInference()` so a swap between hosted and BYOK — or between models — is
 * a config change, not a code change. This module is config + capability logic
 * only; it makes no network calls, so it is fully offline-testable.
 */

// ── Provider / model registry ─────────────────────────────────────────────────
// Curated, known-good defaults. `models` is the menu shown once a key is entered;
// a provider's live /models endpoint can extend this at runtime, but SAGE never
// requires the network just to let a user pick.
export const PROVIDERS = {
  anthropic: {
    label:   'Anthropic (Claude)',
    keyEnv:  'ANTHROPIC_API_KEY',
    endpoint:'https://api.anthropic.com',
    models: [
      { id: 'claude-opus-4-8',            label: 'Claude Opus 4.8',   tier: 'flagship' },
      { id: 'claude-sonnet-4-6',          label: 'Claude Sonnet 4.6', tier: 'balanced' },
      { id: 'claude-haiku-4-5-20251001',  label: 'Claude Haiku 4.5',  tier: 'fast'     },
    ],
    default: 'claude-sonnet-4-6',
  },
  openai: {
    label:   'OpenAI',
    keyEnv:  'OPENAI_API_KEY',
    endpoint:'https://api.openai.com',
    models: [
      { id: 'gpt-4o',      label: 'GPT-4o',      tier: 'flagship' },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini', tier: 'fast'     },
    ],
    default: 'gpt-4o',
  },
  openrouter: {
    label:   'OpenRouter (many models, one key)',
    keyEnv:  'OPENROUTER_API_KEY',
    endpoint:'https://openrouter.ai/api',
    models: [
      { id: 'anthropic/claude-opus-4-8',   label: 'Claude Opus 4.8 (via OpenRouter)', tier: 'flagship' },
      { id: 'openai/gpt-4o',               label: 'GPT-4o (via OpenRouter)',          tier: 'flagship' },
      { id: 'meta-llama/llama-3.1-70b',    label: 'Llama 3.1 70B',                    tier: 'open'     },
    ],
    default: 'anthropic/claude-opus-4-8',
  },
};

export const MODES = { HOSTED: 'hosted', BYOK: 'byok' };

/** List the models a provider offers — the menu to show once a key is entered. */
export function listModels(provider) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown inference provider "${provider}" (known: ${Object.keys(PROVIDERS).join(', ')})`);
  return p.models;
}

/** True if the given model id is offered by the provider. */
export function isValidModel(provider, modelId) {
  return !!PROVIDERS[provider] && PROVIDERS[provider].models.some(m => m.id === modelId);
}

/**
 * Resolve the active inference configuration.
 * Precedence: explicit config.inference, then environment.
 *
 * @param {object} cfg - parsed sage-config.json (may contain `inference`)
 * @param {object} env - process.env (injected for testability)
 * @returns {{ mode, provider, model, apiKeyPresent, hasLicense }}
 */
export function resolveInference(cfg = {}, env = process.env) {
  const ic       = cfg.inference || {};
  const mode     = ic.mode || env.SAGE_INFERENCE_MODE || MODES.BYOK;
  const provider = ic.provider || env.SAGE_INFERENCE_PROVIDER || 'anthropic';
  const known    = PROVIDERS[provider];

  const model = ic.model || env.SAGE_INFERENCE_MODEL || known?.default || null;
  const apiKeyPresent = mode === MODES.BYOK
    ? !!(ic.apiKey || (known && env[known.keyEnv]))
    : false;
  const hasLicense = mode === MODES.HOSTED
    ? !!(ic.license || env.SAGE_LICENSE)
    : false;

  return { mode, provider, model, apiKeyPresent, hasLicense };
}

/**
 * Validate a resolved inference config — is it actually usable?
 *   hosted → needs a license/subscription token.
 *   byok   → needs a known provider, a valid model, and the provider's API key.
 *
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateInference(resolved) {
  const { mode, provider, model, apiKeyPresent, hasLicense } = resolved;

  if (mode === MODES.HOSTED) {
    if (!hasLicense) return { ok: false, reason: 'hosted inference needs a subscription — set SAGE_LICENSE or inference.license' };
    return { ok: true };
  }

  if (mode === MODES.BYOK) {
    const known = PROVIDERS[provider];
    if (!known) return { ok: false, reason: `unknown provider "${provider}"` };
    if (!apiKeyPresent) return { ok: false, reason: `BYOK: set your ${known.label} API key (${known.keyEnv} or inference.apiKey)` };
    if (model && !isValidModel(provider, model)) {
      return { ok: false, reason: `model "${model}" is not offered by ${known.label}; choose one of: ${known.models.map(m => m.id).join(', ')}` };
    }
    return { ok: true };
  }

  return { ok: false, reason: `unknown inference mode "${mode}" (use "hosted" or "byok")` };
}

/**
 * A compact status object for the `sage_inference` tool / onboarding UI: what
 * mode we're in, which model, whether it's usable, and — when a key is present —
 * the selectable models so the UI can offer them.
 */
export function inferenceStatus(cfg = {}, env = process.env) {
  const resolved = resolveInference(cfg, env);
  const check    = validateInference(resolved);
  const provider = PROVIDERS[resolved.provider];
  return {
    ...resolved,
    usable:    check.ok,
    reason:    check.ok ? undefined : check.reason,
    provider_label: provider?.label ?? resolved.provider,
    // Only surface the menu once inference is actually usable (key entered /
    // subscription active), matching "select models when key is entered".
    selectable_models: check.ok && provider ? provider.models : [],
  };
}
