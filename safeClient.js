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
 * SAGE — Safe Client
 *
 * Wraps @safe-global/protocol-kit and @safe-global/api-kit.
 * This is the "body" of the agentic wallet — it can perceive
 * blockchain state and act on it.
 */
import SafeApiKitNS from '@safe-global/api-kit';
import SafeNS, { EthSafeSignature as EthSafeSignatureNamed, generateTypedData } from '@safe-global/protocol-kit';
import { ethers } from 'ethers';

// Both Safe SDKs ship CommonJS with no `exports` map, so under Node ESM the
// default import resolves to the module NAMESPACE OBJECT, not the class —
// `SafeNS.init` is undefined while `SafeNS.default.init` is the real function.
// Reach through `.default` when it's there; the `??` keeps this working if
// either package later ships a genuine ESM default export.
//
// Applied to BOTH deliberately: package.json pins caret ranges (^5.0.0 / ^2.5.0),
// so a minor bump could flip either package's shape silently, and an asymmetric
// guard would then break the mirror way.
const SafeApiKit = SafeApiKitNS?.default ?? SafeApiKitNS;
const Safe       = SafeNS?.default       ?? SafeNS;
// EthSafeSignature wraps an (owner, signature) pair so protocol-kit can execute a
// tx with signatures collected out-of-band (from the Transaction Service). Same
// CJS/ESM interop reach-through as the classes above — the named import wins when
// present, else fall through the namespace.
const EthSafeSignature = EthSafeSignatureNamed ?? SafeNS?.EthSafeSignature ?? SafeNS?.default?.EthSafeSignature;

// Safe execTransaction — used to build the on-chain settlement call. Selector 0x6a761202.
const SAFE_EXEC_IFACE = new ethers.Interface([
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
]);

// ERC-20 transfer(address,uint256) — used to decode token transfers out of calldata
const ERC20_IFACE = new ethers.Interface([
  'function transfer(address to, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
]);

/**
 * Authenticated POST to the Transaction Service.
 *
 * Writes matter as much as reads here: a 429 on confirmTransaction throws away a
 * signature the vault has already produced, which is worse than a failed read.
 */
async function servicePost(txServiceBase, path, body) {
  if (!txServiceBase) throw new Error('no transaction service for this chain');
  const key = process.env.SAFE_API_KEY || '';
  const res = await fetch(`${txServiceBase}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json',
               ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
  if (res.status === 429) throw new Error('Too Many Requests');
  if (!res.ok) throw new Error(`transaction service ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? {} : res.json().catch(() => ({}));
}

// ── Chain configs ────────────────────────────────────────────────────────────
export const CHAINS = {
  polygon: {
    chainId:    137n,
    // NB: the previous default `https://polygon-rpc.com` is dead — it now returns
    // HTTP 401 `API key disabled, reason: tenant disabled`. This is the PRODUCTION
    // chain default, so it failed closed but silently, on the path that matters
    // most. publicnode is keyless and live; POLYGON_RPC still overrides.
    rpc:        process.env.POLYGON_RPC || 'https://polygon-bor-rpc.publicnode.com',
    // Migrated to the unified gateway — the legacy host 308-redirects and api-kit
    // won't follow it (see the Sepolia note below).
    txService:  'https://api.safe.global/tx-service/pol/api',
    name:       'Polygon',
  },
  base: {
    chainId:    8453n,
    rpc:        process.env.BASE_RPC || 'https://mainnet.base.org',
    txService:  'https://api.safe.global/tx-service/base/api',
    name:       'Base',
  },
  ethereum: {
    chainId:    1n,
    rpc:        process.env.ETH_RPC || 'https://eth.llamarpc.com',
    txService:  'https://api.safe.global/tx-service/eth/api',
    name:       'Ethereum',
  },
  amoy: {
    chainId:    80002n,
    // Polygon's active testnet (replaced Mumbai). publicnode is keyless + live;
    // AMOY_RPC overrides.
    rpc:        process.env.AMOY_RPC || 'https://polygon-amoy-bor-rpc.publicnode.com',
    // NB: Safe DROPPED Amoy from its Transaction Service — chainId 80002 is no
    // longer in the supported-chains list and the unified gateway has no route
    // for it. RPC reads work, but api-kit propose/getSafeInfo cannot. Use Sepolia
    // or Base Sepolia for the SAGE propose→signer flow on a testnet.
    txService:  null,
    name:       'Polygon Amoy (testnet, no tx-service)',
  },
  sepolia: {
    chainId:    11155111n,
    // NB: the long-standing default `https://rpc.sepolia.org` is dead (returns a
    // Cloudflare 522 / an HTML error page to JSON-RPC POSTs, not a rate limit).
    // publicnode is keyless and live; SEPOLIA_RPC still overrides.
    rpc:        process.env.SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com',
    // Safe migrated the Transaction Service to api.safe.global/tx-service/<slug>.
    // The old safe-transaction-sepolia.safe.global now 308-redirects there, and
    // api-kit does NOT follow the redirect (getSafeInfo → "Not Found"), so we
    // point at the canonical host directly. (The legacy per-chain hosts are being
    // retired — the other chains here likely need the same migration.)
    txService:  'https://api.safe.global/tx-service/sep/api',
    name:       'Sepolia (testnet)',
  },
};

/**
 * Retry a Transaction Service call through a rate limit.
 *
 * api-kit throws a bare "Too Many Requests" with no backoff of its own, and the Safe API
 * limits aggressively — a bank with nine desks plus a dashboard will hit it routinely.
 * Without this, a transient 429 surfaces as a hard failure in the middle of settlement,
 * which is the worst possible moment to give up on a read.
 *
 * Only retries rate limits. A 4xx that means "you asked for something wrong" must fail
 * immediately, not be hammered.
 */
async function withRetry(fn, { tries = 4, baseMs = 1500, label = 'tx-service' } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      const rateLimited = /too many requests|429|rate.?limit/i.test(msg);
      if (!rateLimited || i === tries - 1) throw e;
      // Exponential backoff with jitter, so parallel desks do not retry in lockstep.
      const wait = baseMs * 2 ** i + Math.floor(Math.random() * 400);
      console.error(`[sage] ${label} rate-limited, retrying in ${wait}ms (${i + 1}/${tries - 1})`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/**
 * Authenticated read against the Transaction Service.
 *
 * The installed api-kit hardcodes its request headers and has no apiKey option, so an
 * API key cannot be threaded through it. Rather than fork or upgrade mid-flight, the
 * hot READ paths go direct with the key attached; api-kit still owns the write paths
 * (propose / confirm), where its request shaping is worth keeping.
 *
 * Falls back to anonymous when no key is configured, so nothing breaks without one.
 */
async function serviceGet(txServiceBase, path) {
  if (!txServiceBase) throw new Error('no transaction service for this chain');
  const key = process.env.SAFE_API_KEY || '';
  const res = await fetch(`${txServiceBase}${path}`, {
    headers: { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
  });
  if (res.status === 429) throw new Error('Too Many Requests');
  if (!res.ok) throw new Error(`transaction service ${res.status}`);
  return res.json();
}

export class SAGEClient {
  /**
   * @param {string} chainKey   - 'polygon' | 'base' | 'ethereum' | 'sepolia'
   * @param {string} safeAddress - the deployed Safe contract address (or null if not yet deployed)
   */
  constructor(chainKey, safeAddress = null) {
    this.chain       = CHAINS[chainKey] || CHAINS.polygon;
    this.safeAddress = safeAddress;
    this.provider    = new ethers.JsonRpcProvider(this.chain.rpc);
    // Pass txServiceUrl explicitly: api-kit only ships defaults for a handful of
    // chains, so testnets like Amoy (80002) throw "no transaction service" unless
    // we hand it the URL from our own CHAINS map.
    this.apiKit      = new SafeApiKit({
      chainId: this.chain.chainId,
      ...(this.chain.txService ? { txServiceUrl: this.chain.txService } : {}),
    });
  }

  /**
   * Decode a transaction proposal into SAGE's canonical detail shape — WITHOUT
   * any network call. Pure and static so it can be shared by the dry-run
   * simulator (which has no safeTxHash to fetch) and by getTransactionDetails,
   * keeping the ERC-20 calldata decoding in exactly one place.
   *
   * @param {{ to:string, value?:string, data?:string, operation?:number, nonce?:number }} p
   * @returns {{ to, value, data, operation, nonce, erc20 }}
   */
  static describeProposal({ to, value = '0', data = '0x', operation, nonce } = {}) {
    let erc20 = null;
    if (data && data !== '0x') {
      try {
        const parsed = ERC20_IFACE.parseTransaction({ data });
        if (parsed && (parsed.name === 'transfer' || parsed.name === 'transferFrom')) {
          erc20 = {
            token_address:   ethers.getAddress(to),           // the ERC-20 contract
            transfer_to:     parsed.args.to,
            transfer_amount: parsed.args.amount.toString(),   // raw units, no decimals applied
          };
        }
      } catch { /* not an ERC-20 transfer — leave erc20 null */ }
    }
    return { to, value, data, operation, nonce, erc20 };
  }

  // ── PERCEPTION — what the wallet sees ────────────────────────────────────

  /** List all transactions pending signature on this Safe. */
  async getPendingTransactions() {
    if (!this.safeAddress) throw new Error('No Safe address configured');
    // Authenticated, like the other reads. This was the last one still routed through
    // api-kit, whose headers cannot carry the API key — so it alone kept hitting the
    // anonymous rate limit and made every desk look rate-limited.
    const res = await withRetry(
      () => serviceGet(this.chain.txService,
                       `/v1/safes/${this.safeAddress}/multisig-transactions/` +
                       `?executed=false&ordering=nonce&limit=60`),
      { label: 'getPendingTransactions' });
    return res.results.map(tx => ({
      safeTxHash:       tx.safeTxHash,
      to:               tx.to,
      value:            tx.value,
      data:             tx.data,
      nonce:            tx.nonce,
      confirmations:    tx.confirmations?.length || 0,
      confirmationsRequired: tx.confirmationsRequired,
      // Owners who have ALREADY signed — lets a batch signer skip txs it has
      // itself confirmed (never double-sign) and know when threshold is reached.
      confirmedBy:      (tx.confirmations || []).map(c => c.owner),
      proposedBy:       tx.proposer,
      submissionDate:   tx.submissionDate,
      // Human-readable
      valuEth:          ethers.formatEther(tx.value || '0'),
    }));
  }

  /**
   * Get the Safe's NATIVE-token balance straight from the RPC.
   *
   * The old implementation called `apiKit.getUsdBalances()` — an endpoint the
   * Safe Transaction Service dropped. The method no longer exists on api-kit
   * v2.x, so every caller hit a `TypeError` at runtime; it was a dead method
   * masquerading as perception. Native balance from the provider is real,
   * keyless, and always available. ERC-20 / USD valuations need a token indexer
   * or price oracle (out of scope here) — expose those through a dedicated tool
   * once one is wired, rather than resurrecting a removed endpoint.
   */
  async getBalance() {
    if (!this.safeAddress) throw new Error('No Safe address configured');
    const wei = await this.provider.getBalance(this.safeAddress);
    return {
      address:    this.safeAddress,
      native_wei: wei.toString(),
      native:     ethers.formatEther(wei),
      symbol:     this.chain.chainId === 137n ? 'POL' : 'ETH',
    };
  }

  /** Get Safe metadata: owners, threshold, nonce. */
  async getSafeInfo() {
    if (!this.safeAddress) throw new Error('No Safe address configured');
    return withRetry(() => serviceGet(this.chain.txService, `/v1/safes/${this.safeAddress}/`),
                     { label: 'getSafeInfo' });
  }

  /**
   * Get executed transaction history, capped at `limit`.
   *
   * `getAllTransactions` accepts only { executed, queued, trusted } — it has NO
   * `limit` option, so the value passed here used to be silently dropped and the
   * service's full default page came back regardless. `sage_history` advertises
   * a `limit`, so we honour it by slicing the page ourselves.
   */
  async getHistory(limit = 20) {
    if (!this.safeAddress) throw new Error('No Safe address configured');
    // Authenticated like the other reads. This was the last api-kit call left, and it is
    // why sage_info kept reporting `recent` as unverified while everything else worked.
    const res = await withRetry(
      () => serviceGet(this.chain.txService,
                       `/v1/safes/${this.safeAddress}/multisig-transactions/` +
                       `?executed=true&ordering=-nonce&limit=${limit}`),
      { label: 'getHistory' });
    return (res.results || []).slice(0, limit);
  }

  // ── ACTION — what the wallet does ─────────────────────────────────────────

  /**
   * Initialise @safe-global/protocol-kit for this Safe with an agent signer.
   * protocol-kit owns the EIP-712 hashing and signature encoding so we never
   * hand-roll them.
   * @param {ethers.Wallet} agentWallet
   * @returns {Promise<Safe>}
   */
  async _protocolKit(agentWallet) {
    if (!this.safeAddress) throw new Error('No Safe address configured');
    // `Safe` here is the interop-resolved class — see the note at the imports.
    return Safe.init({
      provider:    this.chain.rpc,
      signer:      agentWallet.privateKey,
      safeAddress: this.safeAddress,
    });
  }

  /**
   * Fetch a pending transaction from the Transaction Service and decode the
   * fields a policy needs. This is the ground truth — callers must never be
   * trusted to describe a tx they want signed.
   * @param {string} safeTxHash
   */
  async getTransactionDetails(safeTxHash) {
    if (!this.safeAddress) throw new Error('No Safe address configured');
    const tx = await withRetry(() => serviceGet(this.chain.txService, `/v1/multisig-transactions/${safeTxHash}/`), { label: 'getTransaction' });
    // Same canonical shape the simulator produces — ERC-20 decoding lives in
    // describeProposal so perception (real tx) and simulation can't diverge.
    return { safeTxHash, ...SAGEClient.describeProposal(tx) };
  }

  /**
   * Sign (co-sign) a pending transaction as an agent.
   *
   * We rebuild the exact pending tx from the Transaction Service and let
   * protocol-kit produce the EIP-712 SafeTx signature. We refuse to sign if the
   * hash protocol-kit derives from the rebuilt tx does not match the hash we
   * were asked to sign — that would mean the tx we're signing isn't the one on
   * the service.
   *
   * @param {string}         safeTxHash  - hash of the pending tx
   * @param {ethers.Wallet}  agentWallet - the agent's signer
   */
  async signTransaction(safeTxHash, agentWallet) {
    const protocolKit = await this._protocolKit(agentWallet);
    const pending     = await withRetry(() => serviceGet(this.chain.txService, `/v1/multisig-transactions/${safeTxHash}/`), { label: 'getTransaction' });

    const safeTx = await protocolKit.createTransaction({
      transactions: [{
        to:        pending.to,
        value:     pending.value,
        data:      pending.data || '0x',
        operation: pending.operation,
      }],
      options: {
        safeTxGas:      pending.safeTxGas,
        baseGas:        pending.baseGas,
        gasPrice:       pending.gasPrice,
        gasToken:       pending.gasToken,
        refundReceiver: pending.refundReceiver,
        nonce:          pending.nonce,
      },
    });

    const derivedHash = await protocolKit.getTransactionHash(safeTx);
    if (derivedHash.toLowerCase() !== safeTxHash.toLowerCase()) {
      throw new Error(
        `safeTxHash mismatch — service says ${safeTxHash}, protocol-kit derives ${derivedHash}; refusing to sign`,
      );
    }

    const signedTx  = await protocolKit.signTransaction(safeTx);
    // Only the agent has signed here, so encodedSignatures() is exactly its
    // EIP-712 SafeTx signature (correctly-encoded v), which is what the
    // Transaction Service expects for a confirmation.
    const signature = signedTx.encodedSignatures();
    await withRetry(() => servicePost(this.chain.txService,
      `/v1/multisig-transactions/${safeTxHash}/confirmations/`, { signature }), { label: 'confirmTransaction' });

    return { signed: true, safeTxHash, signer: agentWallet.address };
  }

  /**
   * Execute a pending tx that has already collected enough signatures to meet
   * the Safe's threshold. The executing agent pays gas (it acts as the relayer)
   * and must hold native funds on the chain.
   *
   * We rebuild the exact pending tx, re-attach the owner signatures the
   * Transaction Service already holds, and re-derive the EIP-712 hash — refusing
   * to execute if it does not match the requested hash, so we can never execute
   * a different tx than the one that was reviewed and signed.
   *
   * @param {string}        safeTxHash
   * @param {ethers.Wallet} agentWallet - the agent that submits (and pays for) the execution
   */
  async executeTransaction(safeTxHash, agentWallet) {
    const protocolKit = await this._protocolKit(agentWallet);
    const pending     = await withRetry(() => serviceGet(this.chain.txService, `/v1/multisig-transactions/${safeTxHash}/`), { label: 'getTransaction' });

    const confirmations = pending.confirmations || [];
    if (confirmations.length < pending.confirmationsRequired) {
      throw new Error(
        `not enough signatures — have ${confirmations.length}, need ${pending.confirmationsRequired}; refusing to execute`,
      );
    }

    const safeTx = await protocolKit.createTransaction({
      transactions: [{
        to:        pending.to,
        value:     pending.value,
        data:      pending.data || '0x',
        operation: pending.operation,
      }],
      options: {
        safeTxGas:      pending.safeTxGas,
        baseGas:        pending.baseGas,
        gasPrice:       pending.gasPrice,
        gasToken:       pending.gasToken,
        refundReceiver: pending.refundReceiver,
        nonce:          pending.nonce,
      },
    });

    const derivedHash = await protocolKit.getTransactionHash(safeTx);
    if (derivedHash.toLowerCase() !== safeTxHash.toLowerCase()) {
      throw new Error(
        `safeTxHash mismatch — service says ${safeTxHash}, protocol-kit derives ${derivedHash}; refusing to execute`,
      );
    }

    // Re-attach the signatures the Transaction Service already collected so the
    // on-chain execTransaction carries a full, threshold-meeting signature set.
    for (const conf of confirmations) {
      safeTx.addSignature(new EthSafeSignature(conf.owner, conf.signature));
    }

    const exec    = await protocolKit.executeTransaction(safeTx);
    const receipt = await exec.transactionResponse?.wait?.();
    return {
      executed:   true,
      safeTxHash,
      execTxHash: exec.hash ?? receipt?.hash ?? null,
      executor:   agentWallet.address,
    };
  }

  /**
   * Build the on-chain `execTransaction` calldata for a threshold-met transaction.
   *
   * Reaching threshold does NOT settle anything — a Safe transaction still needs
   * someone to submit execTransaction and pay the gas. This produces the calldata for
   * that submission, without needing any key, so both the keyless executor and the
   * dashboard's owner-executes button can share one implementation.
   *
   * Applies the same two guards as executeTransaction(): refuse below threshold, and
   * re-derive the safeTxHash and refuse on mismatch — we must never submit a different
   * transaction than the one that was reviewed and signed.
   *
   * @param {string} safeTxHash
   * @returns {{to, data, value, signers, safeNonce}} unsigned call, ready to be sent
   */
  async buildExecCalldata(safeTxHash) {
    if (!this.safeAddress) throw new Error('No Safe address configured');
    const pending = await withRetry(
      () => serviceGet(this.chain.txService, `/v1/multisig-transactions/${safeTxHash}/`),
      { label: 'getTransaction' });

    const confirmations = pending.confirmations || [];
    const required = pending.confirmationsRequired ?? (await this.getSafeInfo())?.threshold;
    if (confirmations.length < required) {
      throw new Error(
        `not enough signatures — have ${confirmations.length}, need ${required}; refusing to execute`,
      );
    }

    // Re-derive the hash from the fetched fields and refuse if it disagrees with the
    // hash we were asked to execute.
    const info  = await this.getSafeInfo();
    const typed = generateTypedData({
      safeAddress: this.safeAddress,
      safeVersion: info?.version || '1.3.0',
      chainId:     this.chain.chainId,
      data: {
        to:             pending.to,
        value:          pending.value,
        data:           pending.data || '0x',
        operation:      pending.operation,
        safeTxGas:      pending.safeTxGas,
        baseGas:        pending.baseGas,
        gasPrice:       pending.gasPrice,
        gasToken:       pending.gasToken,
        refundReceiver: pending.refundReceiver,
        nonce:          pending.nonce,
      },
    });
    const { SafeTx } = typed.types;
    const derived = ethers.TypedDataEncoder.hash(typed.domain, { SafeTx }, typed.message);
    if (derived.toLowerCase() !== safeTxHash.toLowerCase()) {
      throw new Error(
        `safeTxHash mismatch — service says ${safeTxHash}, locally derived ${derived}; refusing to execute`,
      );
    }

    // The contract requires the signature blob ordered by owner address ASCENDING.
    // Out of order, execTransaction reverts with a signature-validation failure.
    const ordered = [...confirmations].sort((a, b) =>
      ethers.getAddress(a.owner).toLowerCase() < ethers.getAddress(b.owner).toLowerCase() ? -1 : 1);
    const signatures = '0x' + ordered.map(c => c.signature.replace(/^0x/, '')).join('');

    const data = SAFE_EXEC_IFACE.encodeFunctionData('execTransaction', [
      ethers.getAddress(pending.to), pending.value, pending.data || '0x', pending.operation,
      pending.safeTxGas, pending.baseGas, pending.gasPrice,
      ethers.getAddress(pending.gasToken), ethers.getAddress(pending.refundReceiver), signatures,
    ]);

    return {
      to:        ethers.getAddress(this.safeAddress),
      data,
      value:     '0x0',
      signers:   ordered.map(c => c.owner),
      safeNonce: pending.nonce,     // the SAFE's nonce — not the EOA's. See below.
    };
  }

  /**
   * Propose a REJECTION transaction — the only way to refuse a queued transaction.
   *
   * A Safe cannot "decline" anything. Its nonce must be CONSUMED for the queue to move,
   * so refusing means executing something else in that slot: a 0-value call from the Safe
   * to itself, which does nothing. Owners sign that instead, it executes, the nonce
   * advances, and the transaction being refused becomes permanently invalid.
   *
   * Note what this costs. A refusal needs the same threshold and the same gas as a
   * payment — saying no is as consequential as saying yes, and neither can be unilateral.
   *
   * Deleting the proposal instead does NOT work: it leaves the nonce empty, and an empty
   * slot at the head can never be consumed, so everything behind it is frozen forever.
   *
   * @param {number}       nonce        - the Safe nonce to consume
   * @param {RemoteSigner} remoteSigner - proposing owner (adds signature #1)
   */
  async proposeRejectionKeyless(nonce, remoteSigner) {
    if (!this.safeAddress) throw new Error('No Safe address configured');
    if (!Number.isInteger(Number(nonce))) throw new Error('proposeRejectionKeyless: a nonce is required');
    return this.proposeTransactionKeyless(
      { to: this.safeAddress, value: '0', data: '0x' },   // a no-op, on purpose
      remoteSigner,
      { nonce: Number(nonce) },
    );
  }

  /**
   * KEYLESS settlement — submit execTransaction with no private key in this process.
   *
   * The counterpart to signTransactionKeyless. Without it, keyless custody covered
   * proposing and co-signing but not settling, so a PRIVATE deployment could sign to
   * threshold and never put anything on chain.
   *
   * A raw Ethereum transaction's signing payload is a 32-byte keccak digest — exactly
   * what the vault signs. So we build the transaction locally, have the vault sign its
   * digest, and broadcast the result. The key never leaves the vault.
   *
   * ⚠ TWO DIFFERENT NONCES, SAME WORD. `safeNonce` is the Safe contract's internal
   * ordering nonce (part of the EIP-712 payload). `tx.nonce` is the EXECUTOR EOA's
   * Ethereum transaction count. They are unrelated, and using one where the other
   * belongs produces a transaction that either never mines or silently replaces a
   * different one. Nothing else in this file reads an EOA nonce; this is the only place.
   *
   * ⚠ Also unrelated: `safeTxGas` / `baseGas` / `gasPrice` in the Safe payload are
   * EIP-712 fields for the Safe's own refund accounting — NOT the EVM gas for this
   * transaction. EVM gas is estimated separately below.
   *
   * @param {string}       safeTxHash
   * @param {RemoteSigner} remoteSigner - keyless signer for the executor EOA
   * @param {{wait?: boolean, gasLimitMultiplier?: number}} [opts]
   */
  async executeTransactionKeyless(safeTxHash, remoteSigner, opts = {}) {
    const { wait = false, gasLimitMultiplier = 1.25 } = opts;
    const call     = await this.buildExecCalldata(safeTxHash);
    const executor = remoteSigner.getAddress();

    const [eoaNonce, feeData, net] = await Promise.all([
      this.provider.getTransactionCount(executor, 'pending'),
      this.provider.getFeeData(),
      this.provider.getNetwork(),
    ]);

    // Estimate against the real call. If it reverts here it would revert on chain, so
    // failing now is strictly better than paying gas to find out.
    let gasLimit;
    try {
      const est = await this.provider.estimateGas({ from: executor, to: call.to, data: call.data, value: 0n });
      gasLimit = (est * BigInt(Math.round(gasLimitMultiplier * 100))) / 100n;
    } catch (e) {
      throw new Error(
        `gas estimation failed — the execution would revert: ${e.shortMessage || e.message}`);
    }

    const tx = new ethers.Transaction();
    tx.to       = call.to;
    tx.data     = call.data;
    tx.value    = 0n;
    tx.nonce    = eoaNonce;                    // the EXECUTOR's nonce (see warning above)
    tx.gasLimit = gasLimit;
    tx.chainId  = net.chainId;

    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      tx.type                 = 2;             // EIP-1559
      tx.maxFeePerGas         = feeData.maxFeePerGas;
      tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
    } else if (feeData.gasPrice) {
      tx.type     = 0;                         // legacy chains
      tx.gasPrice = feeData.gasPrice;
    } else {
      throw new Error('could not determine gas price for this chain — refusing to broadcast');
    }

    // Prefer the VERIFYING vault path: signTransaction() sends the transaction fields so
    // the vault can rebuild the digest itself and refuse anything that is not an
    // execTransaction to a known Safe. signDigest() is the weaker fallback — it proves
    // who signed but not what, so it is only acceptable where the key is otherwise
    // constrained (e.g. SAGE-free with a local key).
    const signature = typeof remoteSigner.signTransaction === 'function'
      ? await remoteSigner.signTransaction(tx)
      : await remoteSigner.signDigest(tx.unsignedHash);
    tx.signature = signature;

    if (tx.from?.toLowerCase() !== executor.toLowerCase()) {
      throw new Error(
        `signed transaction recovers to ${tx.from}, expected ${executor}; refusing to broadcast`);
    }

    let response;
    try {
      response = await this.provider.broadcastTransaction(tx.serialized);
    } catch (e) {
      // A broadcast rejection (bad nonce, underpriced, no gas funds) is a different
      // problem from an on-chain revert, and conflating them sends you the wrong way.
      throw new Error(`broadcast rejected by the node: ${e.shortMessage || e.message}`);
    }

    const out = { executed: true, safeTxHash, execTxHash: response.hash,
                  executor, keyless: true, safeNonce: call.safeNonce };
    if (!wait) return out;

    const receipt = await response.wait();
    return { ...out, blockNumber: receipt?.blockNumber ?? null,
             reverted: receipt?.status === 0 };
  }

  /**
   * KEYLESS co-signing — no private key in the agent. Compute the canonical Safe
   * EIP-712 hash locally, verify it matches the requested one, then ask the
   * REMOTE SIGNER (vault / Warden) to sign the hash. The key never leaves the
   * vault; we only ever hold the returned signature.
   *
   * Uses protocol-kit's `generateTypedData` (a pure function — no key, no init)
   * to build the exact typed data, so the hash is identical to the canonical one
   * proven in test/hash-conformance.mjs.
   *
   * @param {string}       safeTxHash   - hash of the pending tx to co-sign
   * @param {RemoteSigner} remoteSigner - a keyless signer bound to an owner address
   */
  async signTransactionKeyless(safeTxHash, remoteSigner) {
    if (!this.safeAddress) throw new Error('No Safe address configured');
    const pending = await withRetry(() => serviceGet(this.chain.txService, `/v1/multisig-transactions/${safeTxHash}/`), { label: 'getTransaction' });
    const info    = await this.getSafeInfo();
    const safeVersion = info?.version || '1.3.0';

    const typed = generateTypedData({
      safeAddress: this.safeAddress,
      safeVersion,
      chainId: this.chain.chainId,
      data: {
        to:             pending.to,
        value:          pending.value,
        data:           pending.data || '0x',
        operation:      pending.operation,
        safeTxGas:      pending.safeTxGas,
        baseGas:        pending.baseGas,
        gasPrice:       pending.gasPrice,
        gasToken:       pending.gasToken,
        refundReceiver: pending.refundReceiver,
        nonce:          pending.nonce,
      },
    });
    const { SafeTx } = typed.types;   // drop EIP712Domain for ethers
    const derivedHash = ethers.TypedDataEncoder.hash(typed.domain, { SafeTx }, typed.message);

    if (derivedHash.toLowerCase() !== safeTxHash.toLowerCase()) {
      throw new Error(
        `safeTxHash mismatch — service says ${safeTxHash}, locally derived ${derivedHash}; refusing to sign`,
      );
    }

    // The key stays in the vault; we send the digest and get a signature back.
    const signature = await remoteSigner.signSafeTxHash(derivedHash);
    await withRetry(() => servicePost(this.chain.txService,
      `/v1/multisig-transactions/${safeTxHash}/confirmations/`, { signature }), { label: 'confirmTransaction' });

    return { signed: true, safeTxHash, signer: remoteSigner.getAddress(), keyless: true };
  }

  /**
   * Propose a new transaction to the Safe.
   * @param {object}         tx          - { to, value, data }
   * @param {ethers.Wallet}  agentWallet - the proposing agent
   */
  async proposeTransaction(tx, agentWallet, { nonce } = {}) {
    const protocolKit = await this._protocolKit(agentWallet);

    const safeTx = await protocolKit.createTransaction({
      transactions: [{
        to:        tx.to,
        value:     tx.value || '0',
        data:      tx.data  || '0x',
        operation: 0,   // CALL
      }],
      // Same reasoning as the keyless path: without this, a loop collides on one nonce.
      ...(nonce !== undefined ? { options: { nonce: Number(nonce) } } : {}),
    });

    const safeTxHash = await protocolKit.getTransactionHash(safeTx);
    const signedTx   = await protocolKit.signTransaction(safeTx);

    await withRetry(() => servicePost(this.chain.txService,
      `/v1/safes/${this.safeAddress}/multisig-transactions/`, {
        ...signedTx.data,
        contractTransactionHash: safeTxHash,
        sender:    agentWallet.address,
        signature: signedTx.encodedSignatures(),
        origin:    'SAGE',
      }), { label: 'proposeTransaction' });

    return { proposed: true, safeTxHash, nonce: Number(safeTx.data.nonce) };
  }

  /**
   * The next FREE nonce: one past the highest nonce already queued, not merely the
   * Safe's on-chain nonce.
   *
   * This distinction is the whole ballgame for batches. createTransaction() defaults to
   * the on-chain nonce, which does not advance until something EXECUTES — so proposing
   * N transactions in a loop gives all N the same nonce. A Safe nonce is sequential, so
   * those are not a queue, they are N competing alternatives for one slot: the first to
   * reach threshold executes and the rest are permanently dead.
   */
  async nextNonce() {
    if (!this.safeAddress) throw new Error('No Safe address configured');
    try {
      const q = await withRetry(
        () => serviceGet(this.chain.txService, `/v1/safes/${this.safeAddress}/nonces/`),
        { label: 'getNextNonce' });
      const n = q?.recommendedNonce ?? q?.nextNonce;
      if (n !== undefined && n !== null) return Number(n);
    } catch { /* rate-limited or unreachable — derive it below */ }

    // Fallback must still account for what is ALREADY QUEUED. The on-chain nonce alone
    // is wrong the moment anything is pending: it does not advance until execution, so
    // using it would hand a new proposal a nonce that is already taken and create yet
    // another rival for that slot.
    const [info, pending] = await Promise.all([
      this.getSafeInfo().catch(() => null),
      this.getPendingTransactions().catch(() => []),
    ]);
    const onchain = Number(info?.nonce ?? 0);
    const highestQueued = (pending || []).reduce(
      (max, t) => Math.max(max, Number(t.nonce ?? -1)), -1);
    return Math.max(onchain, highestQueued + 1);
  }

  /**
   * Propose a transaction KEYLESSLY — the counterpart to signTransactionKeyless().
   *
   * Without this, keyless custody only ever covered *approval*: proposeTransaction()
   * requires an ethers.Wallet, i.e. a private key in the agent process, which
   * ARCHITECTURE-secrets.md §0 forbids in PRIVATE. That made proposing impossible
   * in the very tier that mandates keyless, so the whole first-signature step had no
   * compliant path.
   *
   * The key never enters this process: protocol-kit builds the transaction with a
   * provider only (no signer), we derive the EIP-712 digest, the vault signs it, and
   * we submit the signature with the proposal.
   *
   * @param {object} tx - { to, value, data }
   * @param {RemoteSigner} remoteSigner - keyless signer bound to a Safe owner
   */
  async proposeTransactionKeyless(tx, remoteSigner, { nonce } = {}) {
    if (!this.safeAddress) throw new Error('No Safe address configured');

    // No `signer` — protocol-kit only needs a provider to CONSTRUCT a transaction
    // and compute its hash. Signing is the vault's job, not ours.
    const protocolKit = await Safe.init({
      provider:    this.chain.rpc,
      safeAddress: this.safeAddress,
    });

    const safeTx = await protocolKit.createTransaction({
      transactions: [{
        to:        tx.to,
        value:     tx.value || '0',
        data:      tx.data  || '0x',
        operation: 0,   // CALL
      }],
      // An explicit nonce is what makes a batch a QUEUE instead of N rivals for one slot.
      ...(nonce !== undefined ? { options: { nonce: Number(nonce) } } : {}),
    });

    const safeTxHash = await protocolKit.getTransactionHash(safeTx);

    // Derive the digest independently and require it to match protocol-kit's, the
    // same guard signTransactionKeyless() applies. We are about to have a vault sign
    // this hash; if our two derivations disagree we do not know what we are signing.
    const info = await this.getSafeInfo();
    const typed = generateTypedData({
      safeAddress: this.safeAddress,
      safeVersion: info?.version || '1.3.0',
      chainId:     this.chain.chainId,
      data: {
        to:             safeTx.data.to,
        value:          safeTx.data.value,
        data:           safeTx.data.data || '0x',
        operation:      safeTx.data.operation,
        safeTxGas:      safeTx.data.safeTxGas,
        baseGas:        safeTx.data.baseGas,
        gasPrice:       safeTx.data.gasPrice,
        gasToken:       safeTx.data.gasToken,
        refundReceiver: safeTx.data.refundReceiver,
        nonce:          safeTx.data.nonce,
      },
    });
    const { SafeTx } = typed.types;   // drop EIP712Domain for ethers
    const derivedHash = ethers.TypedDataEncoder.hash(typed.domain, { SafeTx }, typed.message);

    if (derivedHash.toLowerCase() !== safeTxHash.toLowerCase()) {
      throw new Error(
        `safeTxHash mismatch — protocol-kit says ${safeTxHash}, locally derived ` +
        `${derivedHash}; refusing to propose`,
      );
    }

    // RemoteSigner verifies the returned signature recovers to the expected owner
    // and throws otherwise, so a wrong vault key is caught before submission.
    const signature = await remoteSigner.signSafeTxHash(derivedHash);

    // Authenticated, like every other service call. api-kit cannot carry the API key, and
    // a 429 here would discard a proposal the vault has already signed.
    await withRetry(() => servicePost(this.chain.txService,
      `/v1/safes/${this.safeAddress}/multisig-transactions/`, {
        ...safeTx.data,
        contractTransactionHash: safeTxHash,
        sender:    remoteSigner.getAddress(),
        signature,
        origin:    'CRIPTOGRAFIA PRIVATE',
      }), { label: 'proposeTransaction' });

    // Return the nonce so a batch caller can VERIFY the one it asked for was used.
    return { proposed: true, safeTxHash, nonce: Number(safeTx.data.nonce),
             signer: remoteSigner.getAddress(), keyless: true };
  }

  // ── COGNITION — what the wallet knows about itself ────────────────────────

  /**
   * Summarise the wallet's current state in a format suitable
   * for an LLM prompt / MCP response.
   */
  async summarise() {
    const [info, pending, history] = await Promise.allSettled([
      this.getSafeInfo(),
      this.getPendingTransactions(),
      this.getHistory(5),
    ]);

    // allSettled keeps a transient RPC / tx-service failure from taking the whole
    // summary down — but the caller MUST be able to tell "nothing there" from
    // "could not check". Carry the failures explicitly: a consumer that renders
    // `owners: []` for a REJECTED getSafeInfo() is reporting a fact it never
    // established, which is the exact opposite of fail-closed.
    const unavailable = {};
    if (info.status    === 'rejected') unavailable.info    = String(info.reason?.message    ?? info.reason);
    if (pending.status === 'rejected') unavailable.pending = String(pending.reason?.message ?? pending.reason);
    if (history.status === 'rejected') unavailable.recent  = String(history.reason?.message ?? history.reason);

    return {
      safe:    this.safeAddress,
      chain:   this.chain.name,
      info:    info.status    === 'fulfilled' ? info.value    : null,
      pending: pending.status === 'fulfilled' ? pending.value : [],
      recent:  history.status === 'fulfilled' ? history.value : [],
      // Present ONLY when something could not be read; absent on a clean call.
      ...(Object.keys(unavailable).length ? { unavailable } : {}),
    };
  }
}
