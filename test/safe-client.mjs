/**
 * Offline unit tests for SAGEClient (safeClient.js).
 *
 * These lock two runtime bugs that had no coverage because the method that
 * would have exposed them either threw immediately or silently ignored its
 * argument:
 *
 *   Bug A — getBalance() called apiKit.getUsdBalances(), an endpoint the Safe
 *           Transaction Service removed; the method does not exist on api-kit
 *           v2.x, so any caller got a TypeError. It now reads the native
 *           balance from the RPC provider.
 *
 *   Bug B — getHistory(limit) passed { executed, limit } to getAllTransactions,
 *           whose options are only { executed, queued, trusted }. The `limit`
 *           was silently dropped, so `sage_history`'s advertised limit did
 *           nothing. It now slices the page to `limit` and never sends the
 *           unsupported option.
 *
 * No network, no keys: apiKit and provider are stubbed on the instance, so the
 * constructor's real objects are never called.
 *
 * Run: node test/safe-client.mjs
 */
import { SAGEClient } from '../safeClient.js';

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const SAFE = '0xe601D7B4103FD508dA521A25D7639F085448196d';

// ── Bug B: getHistory honours `limit` and omits the unsupported option ────────
{
  const client = new SAGEClient('polygon', SAFE);
  let seenOptions = null;
  // 12 fake executed txs — more than any limit we ask for.
  const page = Array.from({ length: 12 }, (_, i) => ({ id: i }));
  client.apiKit = {
    getAllTransactions: async (addr, options) => {
      seenOptions = { addr, options };
      return { results: page };
    },
    // If getHistory ever regressed to calling a paging/limit API, surface it.
  };

  const five = await client.getHistory(5);
  check('getHistory caps results at limit', five.length === 5);
  check('getHistory queried the configured Safe', seenOptions.addr === SAFE);
  check('getHistory requests executed txs', seenOptions.options.executed === true);
  check('getHistory does NOT send the unsupported `limit` option',
    !('limit' in seenOptions.options));

  const all = await client.getHistory(50);
  check('getHistory returns the whole page when limit exceeds it', all.length === 12);

  const def = await client.getHistory();
  check('getHistory default limit (20) returns the available 12', def.length === 12);
}

// ── Bug A: getBalance reads native balance from the provider, not a dead API ──
{
  const client = new SAGEClient('polygon', SAFE);
  let usdBalancesCalled = false;
  client.apiKit = {
    // The removed endpoint. If getBalance ever calls it again, this trips.
    getUsdBalances: async () => { usdBalancesCalled = true; return []; },
  };
  client.provider = {
    getBalance: async (addr) => {
      check('getBalance queries the configured Safe on the RPC', addr === SAFE);
      return 1500000000000000000n; // 1.5 native
    },
  };

  const bal = await client.getBalance();
  check('getBalance does not touch the removed getUsdBalances endpoint', usdBalancesCalled === false);
  check('getBalance reports native_wei as a string', bal.native_wei === '1500000000000000000');
  check('getBalance formats native amount', bal.native === '1.5');
  check('getBalance labels Polygon native as POL', bal.symbol === 'POL');
  check('getBalance echoes the Safe address', bal.address === SAFE);
}

// ── getBalance symbol on an ETH-native chain ──────────────────────────────────
{
  const client = new SAGEClient('base', SAFE);
  client.provider = { getBalance: async () => 0n };
  const bal = await client.getBalance();
  check('getBalance labels Base native as ETH', bal.symbol === 'ETH');
  check('getBalance handles a zero balance', bal.native === '0.0' && bal.native_wei === '0');
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
