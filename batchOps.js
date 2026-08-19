/**
 * SAGE — Batch Operations (the "financial team" workflow)
 *
 * Two agents, one authenticated owner:
 *
 *   proposeBatch — the PROPOSAL agent prepares many transactions and proposes
 *                  them to the Safe, each carrying its own first signature.
 *
 *   approveAll   — the SIGNING agent, on the authenticated owner's instruction
 *                  ("approve all I've checked"), adds its signature to every
 *                  pending tx and — where that reaches the Safe's threshold —
 *                  executes it. Bulk, but INDEPENDENT: one tx failing never
 *                  aborts the rest of the batch.
 *
 * Authorization model — "2 agents + your OK":
 *   The two agents supply the two on-chain signatures (2-of-3). The owner's own
 *   key never signs; instead the owner AUTHORISES the batch as an authenticated
 *   identity (email via Privy in production; the operator of the MCP/CLI session
 *   today). That instruction IS the human co-signature — so approveAll signs even
 *   when the policy engine would HOLD_HUMAN. Every such override records WHO
 *   authorised it and WHAT the policy said, so it is always accountable.
 *
 *   A hard policy REJECT (e.g. an AML flag) is deliberately NOT overridden in the
 *   batch path — those must be handled explicitly, one at a time.
 *
 * This module is pure orchestration over a `client` (a SAGEClient, or any object
 * exposing the same methods) and a `signer` wallet, so it is unit-testable
 * offline with a mock client — no network, keys or funds.
 */
import { evaluate, DECISION }    from './policyEngine.js';
import { deriveTrustedContext }  from './sage.js';

/** Count results by status for a compact summary line. */
function tally(results) {
  return results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
}

/**
 * The proposal agent proposes a batch of transactions.
 *
 * @param {object} client  - SAGEClient (needs proposeTransaction)
 * @param {object} signer  - the proposing agent's ethers.Wallet
 * @param {Array<{to:string,value?:string,data?:string}>} txs
 * @param {{operator?: string}} [opts] - authenticated owner identity (email), for audit
 */
export async function proposeBatch(client, signer, txs, opts = {}) {
  const { operator } = opts;
  if (!Array.isArray(txs) || txs.length === 0) {
    throw new Error('proposeBatch: `txs` must be a non-empty array');
  }

  const results = [];
  for (const tx of txs) {
    const r = { to: tx.to, value: tx.value ?? '0' };
    try {
      if (!tx.to) throw new Error('each tx needs a `to` address');
      const res = await client.proposeTransaction(
        { to: tx.to, value: tx.value ?? '0', data: tx.data ?? '0x' },
        signer,
      );
      r.status = 'proposed';
      r.safeTxHash = res.safeTxHash;
    } catch (e) {
      // Bulk, independent: a bad tx in the list doesn't sink the others.
      r.status = 'error';
      r.error = e.message;
    }
    results.push(r);
  }

  return { operator, proposer: signer.address, count: results.length, summary: tally(results), results };
}

/**
 * The signing agent approves (and, where threshold is reached, executes) every
 * pending transaction, authorised by the owner's instruction.
 *
 * @param {object} client - SAGEClient (needs getPendingTransactions,
 *                          getTransactionDetails, signTransaction, executeTransaction)
 * @param {object} signer - the signing agent's ethers.Wallet
 * @param {{operator: string, execute?: boolean, only?: string[], authorize?: Function, proof?: object}} opts
 *        operator  - REQUIRED authenticated owner identity (email); authorises the batch
 *        execute   - execute txs that reach threshold after signing (default true)
 *        only      - optional allow-list of safeTxHashes to act on (default: all pending)
 *        authorize - optional hardware-2FA gate `(operator, safeTxHashes, proof) => Promise<void>`
 *                    that THROWS to reject. When present, a valid proof is required and the
 *                    WHOLE batch is refused (nothing signed) if it fails — fail-closed.
 *        proof     - the hardware-2FA proof (Trezor / YubiKey) passed to `authorize`
 */
export async function approveAll(client, signer, opts = {}) {
  const { operator, execute = true, only = null, authorize = null, proof = null } = opts;
  if (!operator) {
    throw new Error('approveAll: `operator` identity required — a batch approval must be authorised by an authenticated owner');
  }

  let pending = await client.getPendingTransactions();
  if (Array.isArray(only) && only.length > 0) {
    const set = new Set(only.map(h => h.toLowerCase()));
    pending = pending.filter(tx => set.has(tx.safeTxHash.toLowerCase()));
  }

  // Hardware 2FA gate: verify a device proof bound to THIS exact batch before
  // signing anything. A failure refuses the whole batch — nothing is signed.
  if (authorize) {
    const hashes = pending.map(tx => tx.safeTxHash);
    try {
      await authorize(operator, hashes, proof);
    } catch (e) {
      return {
        operator,
        threshold_model: '2-agents-plus-operator-ok',
        authorized: false,
        error: `hardware 2FA authorization failed: ${e.message}`,
        count: 0, summary: { refused: pending.length }, results: [],
      };
    }
  }

  const results = [];
  for (const tx of pending) {
    const r = { safeTxHash: tx.safeTxHash, to: tx.to, value_eth: tx.valuEth };
    try {
      // Never double-sign a tx this agent already confirmed.
      const alreadySigned = (tx.confirmedBy || [])
        .some(a => a.toLowerCase() === signer.address.toLowerCase());
      if (alreadySigned) {
        r.status = 'skipped';
        r.reason = 'already signed by this agent';
        results.push(r);
        continue;
      }

      // Ground truth: evaluate policy against the REAL pending tx, never caller input.
      const details = await client.getTransactionDetails(tx.safeTxHash);
      const context = deriveTrustedContext(details);
      const { decision, reasons } = evaluate(details, context, 'execution');
      r.policy = decision;
      r.policy_reasons = reasons;

      if (decision === DECISION.REJECT) {
        // Hard reject is NOT overridden by an operator OK in the batch path.
        r.status = 'refused';
        r.reason = `policy REJECT: ${reasons.join('; ')}`;
        results.push(r);
        continue;
      }

      // The authenticated owner reviewed the pending page and authorised this
      // batch — their instruction is the human co-signature. Record the override.
      r.authorized_by = operator;
      if (decision === DECISION.HOLD_HUMAN) r.overrode_hold = true;

      await client.signTransaction(tx.safeTxHash, signer);
      r.status = 'signed';

      const confirmationsAfter = (tx.confirmations || 0) + 1;
      r.confirmations = `${confirmationsAfter}/${tx.confirmationsRequired}`;

      if (execute && confirmationsAfter >= tx.confirmationsRequired) {
        const ex = await client.executeTransaction(tx.safeTxHash, signer);
        r.status = 'executed';
        r.execTxHash = ex.execTxHash;
      }
    } catch (e) {
      // Bulk, independent: one failure never aborts the rest of the batch.
      r.status = 'error';
      r.error = e.message;
    }
    results.push(r);
  }

  return {
    operator,
    threshold_model: '2-agents-plus-operator-ok',
    count:   results.length,
    summary: tally(results),
    results,
  };
}
