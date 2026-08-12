/**
 * Regression test: the reported Safe and the operated Safe must never diverge.
 *
 * WHAT WENT WRONG
 * ---------------
 * The startup banner resolved the Safe env-first:
 *     process.env.SAGE_SAFE_ADDRESS || loadConfig().safe_address
 * while every tool call resolved it config-first:
 *     cfg.safe_address || process.env.SAGE_SAFE_ADDRESS
 *
 * Opposite precedence. So an operator who set SAGE_SAFE_ADDRESS to a testnet
 * Safe was TOLD they were on testnet while every signature went against the
 * configured mainnet Safe. The guard someone would reach for to protect
 * themselves reported success while doing the opposite — worse than no guard,
 * because it manufactures confidence.
 *
 * WHAT THIS ASSERTS
 * -----------------
 * 1. Behaviourally, against the real program: the banner reports the same
 *    address the tools operate on, even when SAGE_SAFE_ADDRESS disagrees.
 * 2. Structurally: there is exactly ONE Safe-resolution expression in sage.js,
 *    so a second, divergent one cannot quietly reappear.
 *
 * sage.js is deliberately NOT imported: its entry point starts an MCP server on
 * import. Everything here drives the real binary as a child process or inspects
 * its source, so no network, keys or funds are involved.
 *
 * Run: node test/safe-address-resolution.mjs   (or `npm test`)
 */
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir  = dirname(fileURLToPath(import.meta.url));
const ROOT   = join(__dir, '..');
const SAGEJS = join(ROOT, 'sage.js');
const SRC    = readFileSync(SAGEJS, 'utf8');
const CFG    = JSON.parse(readFileSync(join(ROOT, 'sage-config.json'), 'utf8'));

// Deliberately unlike anything real, so a match can only come from the env var.
const SENTINEL = '0x1111111111111111111111111111111111111111';

let failures = 0;
// `always` shows the detail even on PASS (used where the detail is an observed
// value worth seeing); diagnoses are shown only when they apply, i.e. on FAIL.
const check = (name, cond, detail = '', always = true) => {
  const show = detail && (always || !cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${show ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

/** Start sage.js, capture the startup banner, kill it. */
function bannerWith(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SAGEJS], {
      cwd:   ROOT,
      env:   { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let out = '';
    const done = (fn, arg) => { clearTimeout(timer); child.kill('SIGKILL'); fn(arg); };
    const timer = setTimeout(() => done(reject, new Error('no banner within 10s')), 10000);

    child.stderr.on('data', (d) => {
      out += d.toString();
      const m = out.match(/Wallet:\s*(\S+)/);
      if (m) done(resolve, m[1]);
    });
    child.on('error', e => done(reject, e));
    child.on('exit', () => {
      const m = out.match(/Wallet:\s*(\S+)/);
      if (m) done(resolve, m[1]); else done(reject, new Error(`no banner; stderr: ${out.slice(0, 200)}`));
    });
  });
}

// What the tools resolve to, by the precedence they have always used.
const operating = CFG.safe_address || SENTINEL;

// ── 1. Banner must not contradict the operating Safe ─────────────────────────
// THE regression: env var set, and disagreeing with config.
try {
  const banner = await bannerWith({ SAGE_SAFE_ADDRESS: SENTINEL });
  check(
    'banner reports the Safe the tools operate on (env var disagreeing)',
    banner.toLowerCase() === operating.toLowerCase(),
    `banner=${banner} operating=${operating}`,
  );
  if (CFG.safe_address) {
    check(
      'banner does NOT report the env var while operating on the configured Safe',
      banner.toLowerCase() !== SENTINEL.toLowerCase(),
      banner.toLowerCase() === SENTINEL.toLowerCase()
        ? 'banner claims the env Safe but tools use the configured one — the original defect'
        : '',
    );
  }
} catch (e) {
  check('banner reports the Safe the tools operate on (env var disagreeing)', false, e.message);
}

// ── 2. And with no env var at all ────────────────────────────────────────────
try {
  const banner = await bannerWith({ SAGE_SAFE_ADDRESS: undefined });
  const expected = CFG.safe_address || '(not';
  check(
    'banner matches the configured Safe when no env var is set',
    banner.toLowerCase().startsWith(expected.toLowerCase()),
    `banner=${banner}`,
  );
} catch (e) {
  check('banner matches the configured Safe when no env var is set', false, e.message);
}

// ── 3. Structural: only one resolution expression may exist ──────────────────
// Prevents a second, divergent expression from reappearing. Counts real uses
// only — the operator-facing error string mentions the var name but not
// `process.env.`, so it is not matched here.
const envUses = (SRC.match(/process\.env\.SAGE_SAFE_ADDRESS/g) || []).length;
check(
  'sage.js reads SAGE_SAFE_ADDRESS in exactly one place',
  envUses === 1,
  `found ${envUses}; all resolution must go through resolveSafeAddress()`,
);

// That one read must live INSIDE resolveSafeAddress — one occurrence in the
// wrong function would satisfy the count above while still diverging.
const fnStart = SRC.indexOf('export function resolveSafeAddress');
const fnBody  = fnStart === -1 ? '' : SRC.slice(fnStart, SRC.indexOf('\n}', fnStart));
check(
  'the sole SAGE_SAFE_ADDRESS read is inside resolveSafeAddress()',
  fnStart !== -1 && (fnBody.match(/process\.env\.SAGE_SAFE_ADDRESS/g) || []).length === 1,
  'the env read is somewhere other than the shared resolver',
  false,
);

// The specific inverted expression that caused the defect must not return.
check(
  'the env-first banner expression is gone',
  !/process\.env\.SAGE_SAFE_ADDRESS\s*\|\|\s*loadConfig\(\)/.test(SRC),
  'the env-first resolution is present again',
  false,
);

// Outside the resolver, nothing may rebuild the expression inline.
const outsideResolver = fnStart === -1 ? SRC : SRC.slice(0, fnStart) + SRC.slice(fnStart + fnBody.length);
check(
  'no call site rebuilds the resolution inline',
  !/(cfg|loadConfig\(\))\.safe_address\s*\|\|\s*process\.env/.test(outsideResolver),
  'an inline resolution expression exists outside resolveSafeAddress()',
  false,
);

check(
  'the banner line goes through resolveSafeAddress()',
  /MCP server running on stdio[\s\S]{0,200}?resolveSafeAddress\(\)/.test(SRC),
  'banner does not use the shared resolver',
  false,
);

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
