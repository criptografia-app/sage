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
 * @param {object} client  - SAGEClient (needs proposeTransaction / proposeTransactionKeyless)
 * @param {object|null} signer - the proposing agent's ethers.Wallet. May be null when
 *                               `opts.keyless` is supplied — in PRIVATE there is no
 *                               local wallet to hand over.
 * @param {Array<{to:string,value?:string,data?:string}>} txs
 * @param {{operator?: string, keyless?: object}} [opts]
 *   operator - authenticated owner identity (email), for audit
 *   keyless  - a RemoteSigner; when present the key stays in the vault and each
 *              proposal is signed there. Required in PRIVATE, where a local key in
 *              an agent is a policy violation (ARCHITECTURE-secrets.md §0).
 */
export async function proposeBatch(client, signer, txs, opts = {}) {
  const { operator, keyless } = opts;
  if (!Array.isArray(txs) || txs.length === 0) {
    throw new Error('proposeBatch: `txs` must be a non-empty array');
  }
  if (!signer && !keyless) {
    throw new Error('proposeBatch: needs either a local `signer` or `opts.keyless`');
  }

  // ── nonce plan ─────────────────────────────────────────────────────────────
  // Assign every nonce UP FRONT and validate the whole plan before proposing anything.
  //
  // This is a hard invariant, not an optimisation. createTransaction() defaults to the
  // Safe's ON-CHAIN nonce, which does not advance until something EXECUTES — so a naive
  // loop gives every transaction in the batch the same nonce. Those are not a queue,
  // they are N rivals for one slot: the first to reach threshold executes and the rest
  // are permanently dead. It looks like a working batch right up until you try to settle
  // it, which is the worst possible time to find out.
  //
  // Fail CLOSED: if we cannot establish a safe plan we propose NOTHING, rather than
  // emitting a batch that silently cannot settle.
  const { allowNonceCollision = false } = opts;

  let base;
  try {
    base = await client.nextNonce();
  } catch (e) {
    throw new Error(
      `proposeBatch: cannot determine the next free nonce (${e.message}). Refusing to ` +
      `propose: without an explicit nonce per transaction the batch would collide on one ` +
      `slot and only one transaction could ever execute.`);
  }
  if (!Number.isInteger(base) || base < 0) {
    throw new Error(`proposeBatch: nextNonce() returned ${base}, which is not a usable nonce`);
  }

  // Only entries that can be proposed get a slot. A malformed entry must not consume a
  // nonce: Safe executes strictly in nonce order, so a hole in the sequence would strand
  // every later transaction behind it.
  const plan = txs.filter(tx => tx && tx.to).map((_, i) => base + i);

  // Distinct and strictly sequential — cheap to assert, and the assertion is the point.
  const distinct = new Set(plan);
  if (distinct.size !== plan.length) {
    throw new Error(`proposeBatch: nonce plan has duplicates (${plan.join(', ')}) — refusing`);
  }
  for (let i = 1; i < plan.length; i++) {
    if (plan[i] !== plan[i - 1] + 1) {
      throw new Error(`proposeBatch: nonce plan is not sequential (${plan.join(', ')}) — refusing`);
    }
  }

  // Do not walk into a slot that is already occupied. nextNonce() should prevent this,
  // but a stale service read or a concurrent proposer would otherwise create exactly the
  // rivalry this guard exists to stop.
  if (!allowNonceCollision && typeof client.getPendingTransactions === 'function') {
    let queued = null;
    try { queued = await client.getPendingTransactions(); }
    catch { queued = null; }   // unreadable queue: the plan above still holds
    if (queued) {
      const taken = new Set(queued.map(t => Number(t.nonce)));
      const clash = plan.filter(n => taken.has(n));
      if (clash.length) {
        throw new Error(
          `proposeBatch: nonce(s) ${clash.join(', ')} already have queued transactions. ` +
          `Proposing here would create rival transactions for the same slot, and only one ` +
          `could ever execute. Resolve or execute the existing queue first, or pass ` +
          `allowNonceCollision:true if a deliberate replacement is intended.`);
      }
    }
  }

  // The batch must stay GAPLESS. A failed proposal may or may not have occupied its slot
  // (a timeout can land on the service anyway), so the next transaction reuses that slot
  // only when the queue proves it is still free. Otherwise the rest of the batch is
  // skipped: proposing past an unknown slot would create a gap or a rival, and either one
  // makes later transactions unexecutable.
  async function slotIsFree(n) {
    if (typeof client.getPendingTransactions !== 'function') return false;
    try {
      const queued = await client.getPendingTransactions();
      return !queued.some(t => Number(t.nonce) === n);
    } catch { return false; }
  }

  const results = [];
  let next = base;
  let halted = null;
  for (const tx of txs) {
    const r = { to: tx?.to, value: tx?.value ?? '0' };
    if (!tx || !tx.to) {
      r.status = 'error';
      r.error = 'each tx needs a `to` address';
      results.push(r);
      continue;
    }
    if (halted) {
      r.status = 'skipped';
      r.error = halted;
      results.push(r);
      continue;
    }
    const want = next;
    try {
      const payload = { to: tx.to, value: tx.value ?? '0', data: tx.data ?? '0x' };
      const res = keyless
        ? await client.proposeTransactionKeyless(payload, keyless, { nonce: want })
        : await client.proposeTransaction(payload, signer, { nonce: want });
      r.nonce = res.nonce ?? want;

      // Trust nothing: confirm the nonce we asked for is the nonce that was proposed.
      // A silently-ignored nonce option is the exact failure this guard exists to catch.
      if (res.nonce !== undefined && Number(res.nonce) !== want) {
        throw new Error(`nonce not honoured: asked for ${want}, got ${res.nonce}`);
      }
      r.status = 'proposed';
      r.safeTxHash = res.safeTxHash;
      if (keyless) r.keyless = true;
      next = want + 1;
    } catch (e) {
      // Bulk, independent where that is provably safe: the next tx takes this slot.
      r.status = 'error';
      r.error = e.message;
      if (!(await slotIsFree(want))) {
        halted = `not proposed: the proposal at nonce ${want} failed and that slot cannot ` +
                 `be confirmed free, so proposing further would leave a nonce gap or rival`;
      }
    }
    results.push(r);
  }

  const proposer = keyless ? keyless.getAddress() : signer.address;
  return { operator, proposer, count: results.length, summary: tally(results), results,
           ...(keyless ? { keyless: true } : {}) };
}

/**
 * The signing agent approves (and, where threshold is reached, executes) every
 * pending transaction, authorised by the owner's instruction.
 *
 * @param {object} client - SAGEClient (needs getPendingTransactions,
 *                          getTransactionDetails, signTransaction[Keyless], executeTransaction)
 * @param {object|null} signer - the signing agent's ethers.Wallet. May be null when
 *                               `opts.keyless` is supplied — in PRIVATE there is no
 *                               local wallet to hand over (ARCHITECTURE-secrets.md §0).
 * @param {{operator: string, execute?: boolean, only?: string[], authorize?: Function, proof?: object, keyless?: object}} opts
 *        operator  - REQUIRED authenticated owner identity (email); authorises the batch
 *        execute   - execute txs that reach threshold after signing (default true)
 *        only      - optional allow-list of safeTxHashes to act on (default: all pending)
 *        authorize - optional hardware-2FA gate `(operator, safeTxHashes, proof) => Promise<void>`
 *                    that THROWS to reject. When present, a valid proof is required and the
 *                    WHOLE batch is refused (nothing signed) if it fails — fail-closed.
 *        proof     - the hardware-2FA proof (Trezor / YubiKey) passed to `authorize`
 *        keyless   - a RemoteSigner; when present the key stays in the vault and each
 *                    signature is produced there. Required in PRIVATE.
 *        executor  - a RemoteTxSigner for KEYLESS SETTLEMENT. Signing and settling are
 *                    separate capabilities: signing produces a Safe owner signature,
 *                    settling broadcasts an Ethereum transaction and pays gas. Supplying
 *                    an executor lets a keyless run land what it signs. Without one, a
 *                    keyless run signs to threshold and reports execution as deferred.
 */
export async function approveAll(client, signer, opts = {}) {
  const { operator, execute = true, only = null, authorize = null, proof = null,
          keyless = null, executor = null } = opts;
  if (!operator) {
    throw new Error('approveAll: `operator` identity required — a batch approval must be authorised by an authenticated owner');
  }
  if (!signer && !keyless) {
    throw new Error('approveAll: needs either a local `signer` or `opts.keyless`');
  }
  const signerAddress = keyless ? keyless.getAddress() : signer.address;

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
        .some(a => a.toLowerCase() === signerAddress.toLowerCase());
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

      if (keyless) {
        await client.signTransactionKeyless(tx.safeTxHash, keyless);
        r.keyless = true;
      } else {
        await client.signTransaction(tx.safeTxHash, signer);
      }
      r.status = 'signed';

      const confirmationsAfter = (tx.confirmations || 0) + 1;
      r.confirmations = `${confirmationsAfter}/${tx.confirmationsRequired}`;

      if (execute && confirmationsAfter >= tx.confirmationsRequired) {
        if (keyless && executor) {
          // Keyless settlement: the vault signs the raw transaction after verifying it
          // is an execTransaction to a known Safe, and we broadcast the result. No key
          // in this process at any point.
          //
          // Settlement is attempted per transaction and failures stay local: a Safe
          // executes in strict nonce order, so anything behind the queue head simply is
          // not its turn yet. That is not an error, and it must not abort the batch.
          try {
            const ex = await client.executeTransactionKeyless(tx.safeTxHash, executor);
            r.status = 'executed';
            r.execTxHash = ex.execTxHash;
            r.keylessExecution = true;
          } catch (e) {
            r.executable = true;
            r.execution = `deferred — ${e.message}`;
          }
        } else if (keyless) {
          // Signed to threshold but no executor was supplied, so nothing can broadcast.
          // Report honestly rather than failing or silently claiming execution.
          r.executable = true;
          r.execution = 'deferred — threshold reached; no keyless executor supplied (pass opts.executor)';
        } else {
          const ex = await client.executeTransaction(tx.safeTxHash, signer);
          r.status = 'executed';
          r.execTxHash = ex.execTxHash;
        }
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

/**
 * Settle every transaction that is already signed to threshold, in nonce order.
 *
 * WHY THIS EXISTS. Signing and settling are separate acts, and the queue only ever has
 * ONE executable transaction: a Safe executes in strict nonce order, so everything behind
 * the head reverts with GS026 no matter how well signed it is. approveAll settles what it
 * can at the moment it signs — but as soon as the head lands, the next transaction
 * becomes executable and nothing was revisiting it. approveAll will not: it skips
 * transactions this agent already signed. So a fully-signed queue sat there, complete and
 * going nowhere, waiting for a human to poke it forward one at a time.
 *
 * That is a latency defect, not a safety feature. This drains the queue: settle the head,
 * let the Safe's nonce advance, settle the new head, repeat until something is not ready.
 *
 * Signs nothing. It can only broadcast transactions that ALREADY meet threshold, so it
 * adds no authority — it just stops signed work from stalling.
 *
 * @param {object} client   - SAGEClient
 * @param {object} executor - RemoteTxSigner (keyless settlement)
 * @param {{only?: string[], max?: number}} [opts]
 *        only - optional allow-list of safeTxHashes to settle (scope guard)
 *        max  - safety stop on iterations (default 25)
 */
export async function settlePending(client, executor, opts = {}) {
  const { only = null, max = 25 } = opts;
  if (!executor) throw new Error('settlePending: a keyless executor is required');
  const allow = Array.isArray(only) && only.length
    ? new Set(only.map(h => h.toLowerCase()))
    : null;

  const results = [];
  for (let i = 0; i < max; i++) {
    let pending;
    try { pending = await client.getPendingTransactions(); }
    catch (e) { results.push({ status: 'error', error: `could not read the queue: ${e.message}` }); break; }

    // Ground truth for "what can execute now" is the Safe's own nonce.
    const info = await client.getSafeInfo().catch(() => null);
    const safeNonce = Number(info?.nonce ?? NaN);
    if (Number.isNaN(safeNonce)) {
      results.push({ status: 'error', error: 'safe nonce unreadable — refusing to settle blind' });
      break;
    }

    const head = pending
      .filter(t => Number(t.nonce) === safeNonce)
      .filter(t => (t.confirmations ?? 0) >= t.confirmationsRequired)
      .filter(t => !allow || allow.has(t.safeTxHash.toLowerCase()))
      .sort((a, b) => a.submissionDate < b.submissionDate ? -1 : 1)[0];

    if (!head) break;                      // nothing executable and in scope — done

    try {
      const ex = await client.executeTransactionKeyless(head.safeTxHash, executor, { wait: true });
      results.push({ status: ex.reverted ? 'reverted' : 'settled',
                     safeTxHash: head.safeTxHash, nonce: head.nonce,
                     value: head.value, execTxHash: ex.execTxHash });
      if (ex.reverted) break;              // a revert at the head blocks everything behind it
    } catch (e) {
      results.push({ status: 'error', safeTxHash: head.safeTxHash, nonce: head.nonce,
                     error: e.message });
      break;                               // the head is stuck; nothing behind it can move
    }
  }

  return {
    settled: results.filter(r => r.status === 'settled').length,
    count: results.length,
    summary: tally(results),
    results,
  };
}
