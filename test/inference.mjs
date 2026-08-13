/**
 * Offline tests for the inference layer (inference.js) — the BYOK / hosted
 * monetization paths and model selection. No network.
 *
 * Run: node test/inference.mjs   (or `npm test`)
 */
import { resolveInference, validateInference, inferenceStatus, listModels, isValidModel, MODES } from '../inference.js';

let failures = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };

// ── defaults: BYOK / anthropic ────────────────────────────────────────────────
{
  const r = resolveInference({}, {});
  check('default mode is BYOK', r.mode === MODES.BYOK);
  check('default provider is anthropic', r.provider === 'anthropic');
  check('default model is the provider default', r.model === 'claude-sonnet-4-6');
  check('no key present by default → not usable', validateInference(r).ok === false);
}

// ── BYOK: usable once the provider key is entered ─────────────────────────────
{
  const r = resolveInference({}, { ANTHROPIC_API_KEY: 'sk-ant-xxx' });
  check('BYOK becomes usable when the key is present', validateInference(r).ok === true && r.apiKeyPresent);
  const status = inferenceStatus({}, { ANTHROPIC_API_KEY: 'sk-ant-xxx' });
  check('selectable models are surfaced only once usable', status.selectable_models.length === 3);
  check('status has no models before a key is entered', inferenceStatus({}, {}).selectable_models.length === 0);
}

// ── BYOK: config apiKey also counts; model must be valid for provider ─────────
{
  const okCfg  = { inference: { mode: 'byok', provider: 'openai', apiKey: 'sk-oai', model: 'gpt-4o' } };
  check('config-level apiKey satisfies BYOK', validateInference(resolveInference(okCfg, {})).ok === true);
  const badModel = { inference: { mode: 'byok', provider: 'openai', apiKey: 'sk-oai', model: 'claude-opus-4-8' } };
  const v = validateInference(resolveInference(badModel, {}));
  check('a model not offered by the provider is rejected', v.ok === false && /not offered/.test(v.reason));
}

// ── hosted: needs a license ───────────────────────────────────────────────────
{
  const noLic = resolveInference({ inference: { mode: 'hosted' } }, {});
  check('hosted without a license → not usable', validateInference(noLic).ok === false && /subscription/.test(validateInference(noLic).reason));
  const lic = resolveInference({ inference: { mode: 'hosted' } }, { SAGE_LICENSE: 'lic_123' });
  check('hosted with a license → usable', validateInference(lic).ok === true && lic.hasLicense);
}

// ── precedence: env overrides when config is silent ───────────────────────────
{
  const r = resolveInference({}, { SAGE_INFERENCE_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'or-key' });
  check('env selects provider when config is silent', r.provider === 'openrouter' && validateInference(r).ok === true);
  check('config wins over env', resolveInference({ inference: { provider: 'openai', apiKey: 'k', model: 'gpt-4o' } }, { SAGE_INFERENCE_PROVIDER: 'openrouter' }).provider === 'openai');
}

// ── model helpers ─────────────────────────────────────────────────────────────
check('listModels returns the provider menu', listModels('anthropic').length === 3);
check('listModels throws on unknown provider', (() => { try { listModels('nope'); return false; } catch { return true; } })());
check('isValidModel true for a real model', isValidModel('anthropic', 'claude-opus-4-8'));
check('isValidModel false for a foreign model', isValidModel('anthropic', 'gpt-4o') === false);

// ── unknown provider / mode ───────────────────────────────────────────────────
check('unknown provider in BYOK → not usable', validateInference(resolveInference({ inference: { provider: 'foobar', apiKey: 'x' } }, {})).ok === false);

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
