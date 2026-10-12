/**
 * REGRESSION GUARD — a batch must never race on a nonce again.
 *
 * The original defect: createTransaction() defaults to the Safe's ON-CHAIN nonce, which
 * does not advance until a transaction EXECUTES. A loop of proposals therefore handed
 * every transaction the same nonce, producing N rivals for one slot instead of a queue —
 * only one could ever settle and the rest were silently dead. It presented as a healthy
 * ten-item queue and only failed at settlement.
 *
 * Runs offline against a mock client: no network, no keys, no funds.
 *   node test/nonce-race.test.mjs
 */
import { proposeBatch } from '../batchOps.js';
let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}`); };
const sig = { getAddress: () => '0xaaaAaAaaAAaAAaAAAaAaaaAAAAaaaAAAaAAAAAaa' };
const txs = n => Array.from({length:n}, (_,i)=>({to:'0xbbbBbBbbBBbBBbBBBbBbbbBBBBbbbBBBbBBBBBbb', value:String(i+1)}));

// 1. happy path: distinct sequential nonces
{
  const used = [];
  const c = { nextNonce: async()=>5, getPendingTransactions: async()=>[],
    proposeTransactionKeyless: async(p,s,o)=>{ used.push(o.nonce); return {safeTxHash:'0x'+used.length, nonce:o.nonce}; } };
  const r = await proposeBatch(c, null, txs(4), { keyless: sig });
  t('assigns sequential nonces from nextNonce', JSON.stringify(used)==='[5,6,7,8]');
  t('all proposed', r.summary.proposed===4);
}
// 2. THE bug: nonce option silently ignored → must throw, not proceed
{
  const c = { nextNonce: async()=>0, getPendingTransactions: async()=>[],
    proposeTransactionKeyless: async()=>({safeTxHash:'0x1', nonce:0}) };  // always 0
  const r = await proposeBatch(c, null, txs(3), { keyless: sig });
  t('detects an ignored nonce option', r.results.slice(1).every(x=>x.status==='error'));
}
// 3. collision with an existing queued nonce → refuse the whole batch
{
  let called = 0;
  const c = { nextNonce: async()=>3, getPendingTransactions: async()=>[{nonce:4}],
    proposeTransactionKeyless: async()=>{ called++; return {safeTxHash:'0x1',nonce:3}; } };
  let threw = false;
  try { await proposeBatch(c, null, txs(3), { keyless: sig }); } catch { threw = true; }
  t('refuses a batch that would collide with the queue', threw);
  t('proposes NOTHING when the plan is unsafe', called===0);
}
// 4. deliberate replacement is still possible
{
  const used = [];
  const c = { nextNonce: async()=>3, getPendingTransactions: async()=>[{nonce:3}],
    proposeTransactionKeyless: async(p,s,o)=>{ used.push(o.nonce); return {safeTxHash:'0x1',nonce:o.nonce}; } };
  const r = await proposeBatch(c, null, txs(2), { keyless: sig, allowNonceCollision: true });
  t('allowNonceCollision permits an intentional replacement', used.length===2);
}
// 5. unknown next nonce → refuse rather than guess
{
  let called = 0;
  const c = { nextNonce: async()=>{ throw new Error('service down'); },
    proposeTransactionKeyless: async()=>{ called++; return {}; } };
  let threw = false;
  try { await proposeBatch(c, null, txs(2), { keyless: sig }); } catch { threw = true; }
  t('refuses when the next nonce cannot be established', threw && called===0);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
