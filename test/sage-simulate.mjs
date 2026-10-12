/**
 * sage_simulate building blocks (CRIPTO-180 / SAGE-4).
 *
 * sage_simulate is a dry-run: resolve recipient → decode calldata → run the
 * policy engine, WITHOUT proposing or signing. Its two reusable primitives are
 * tested here offline (no network, keys or funds):
 *
 *   1. SAGEClient.describeProposal() — the pure ERC-20 calldata decoder now
 *      shared by BOTH the simulator and getTransactionDetails, so perception of
 *      a real tx and simulation of a hypothetical one can't diverge.
 *   2. The context composition the handler uses: start from the fail-closed
 *      trusted context, overlay caller `assume` for what-if analysis. Proves the
 *      dry-run reflects hypothetical facts WITHOUT those facts ever reaching a
 *      real signing path.
 *
 * Run: node test/sage-simulate.mjs   (or `npm test`)
 */
import { ethers } from 'ethers';
import { SAGEClient } from '../safeClient.js';
import { deriveTrustedContext } from '../sage.js';
import { evaluate, DECISION } from '../policyEngine.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  const show = detail && !cond;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${show ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

// ── 1. describeProposal decodes an ERC-20 transfer ───────────────────────────
{
  const token = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F';      // USDT on Polygon
  const to    = '0x1111111111111111111111111111111111111111';
  const iface = new ethers.Interface(['function transfer(address to, uint256 amount)']);
  const data  = iface.encodeFunctionData('transfer', [to, 5_000_000n]); // 5 USDT (6dp)

  const d = SAGEClient.describeProposal({ to: token, value: '0', data });
  check('ERC-20 transfer is decoded', !!d.erc20, JSON.stringify(d));
  check('token_address is the contract (checksummed)', d.erc20?.token_address === ethers.getAddress(token));
  check('transfer_to is recovered', d.erc20?.transfer_to === to);
  check('transfer_amount is raw units as string', d.erc20?.transfer_amount === '5000000');
}

// ── 2. A plain native transfer has no erc20 payload ──────────────────────────
{
  const d = SAGEClient.describeProposal({ to: '0x2222222222222222222222222222222222222222', value: '1000000000000000000' });
  check('native transfer → erc20 is null', d.erc20 === null);
  check('value is preserved', d.value === '1000000000000000000');
}

// ── 3. Dry-run context: fail-closed base with no assumptions holds for human ─
{
  const details = SAGEClient.describeProposal({ to: '0x3333333333333333333333333333333333333333', value: '0' });
  const context = { ...deriveTrustedContext(details) };   // no `assume`
  const { decision } = evaluate(details, context);
  check('no assumptions → HOLD_HUMAN (fail-closed base)', decision === DECISION.HOLD_HUMAN);
}

// ── 4. Dry-run what-if: assume clears everything under limit → AUTO_SIGN ──────
{
  const details = SAGEClient.describeProposal({ to: '0x4444444444444444444444444444444444444444', value: '0' });
  const assume  = {
    kyc_verified: true, aml_clear: true, value_usd: 100, is_new_address: false,
    now: new Date('2025-06-11T15:00:00Z'),   // Wed 12h BRT — inside operating hours
    token: 'USDT',                            // auto-sign requires a whitelisted token
  };
  const { decision, reasons } = evaluate(details, { ...deriveTrustedContext(details), ...assume });
  check('what-if cleared + under limit → AUTO_SIGN', decision === DECISION.AUTO_SIGN,
    `decision=${decision} reasons=${JSON.stringify(reasons)}`);
}

// ── 5. Dry-run what-if: assume an over-limit value → HOLD_HUMAN ───────────────
{
  const details = SAGEClient.describeProposal({ to: '0x5555555555555555555555555555555555555555', value: '0' });
  const assume  = {
    kyc_verified: true, aml_clear: true, value_usd: 25000, is_new_address: false,
    now: new Date('2025-06-11T15:00:00Z'),
  };
  const { decision } = evaluate(details, { ...deriveTrustedContext(details), ...assume });
  check('what-if over-limit value → HOLD_HUMAN', decision === DECISION.HOLD_HUMAN);
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
