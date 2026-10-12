/**
 * Daemon monitor pass — pollPending() (CRIPTO-182 / SAGE-6).
 *
 * WHY THIS EXISTS
 * ---------------
 * The container entrypoint is `node sage.js daemon`. Before this, no `daemon`
 * command existed, so it fell through to the stdio MCP server, which EOF'd on a
 * container's stdin and exited — and `restart: unless-stopped` turned that into
 * a boot-loop (the "MCP server running on stdio" spam). The daemon must instead
 * be a long-lived monitor. This locks in the monitor's core contract.
 *
 * WHAT THIS ASSERTS (offline — a fake client, no network, keys or funds)
 * ----------------------------------------------------------------------
 * 1. Every pending tx is actually EVALUATED (getTransactionDetails is fetched
 *    per tx), not merely listed — the policy pass is the point of the daemon.
 * 2. One tx whose details fetch throws mid-pass does NOT sink the whole pass:
 *    the remaining txs are still evaluated and the full count is returned.
 *
 * Run: node test/daemon-monitor.mjs   (or `npm test`)
 */
process.env.NODE_ENV = 'test';          // silence audit console output
delete process.env.WHATSAPP_BRIDGE_URL; // keep notifyHold a no-op (no network)

import { pollPending } from '../sage.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  const show = detail && !cond;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${show ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

const fetched = [];
const fakeClient = {
  async getPendingTransactions() {
    return [
      { safeTxHash: '0xaaa', to: '0x1111111111111111111111111111111111111111', valuEth: '1.0' },
      { safeTxHash: '0xbad', to: '0x2222222222222222222222222222222222222222', valuEth: '2.0' },
      { safeTxHash: '0xccc', to: '0x3333333333333333333333333333333333333333', valuEth: '3.0' },
    ];
  },
  async getTransactionDetails(hash) {
    fetched.push(hash);
    // Simulate a tx that 404s mid-poll (e.g. executed by another owner between
    // the list and the detail fetch). Must not abort the rest of the pass.
    if (hash === '0xbad') throw new Error('No MultisigTransaction matches the given query.');
    return { to: '0x1111111111111111111111111111111111111111', value: '1000000000000000000' };
  },
};

const count = await pollPending(fakeClient);

check('pollPending returns the full pending count', count === 3, `got ${count}`);
check('every pending tx is evaluated (details fetched)',
  fetched.length === 3 && fetched.includes('0xaaa') && fetched.includes('0xccc'),
  JSON.stringify(fetched));
check('a failing tx does not abort the pass — the tx after it is still evaluated',
  fetched.includes('0xccc'), JSON.stringify(fetched));

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
