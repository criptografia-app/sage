/**
 * SAGE — Safe Client
 *
 * Wraps @safe-global/protocol-kit and @safe-global/api-kit.
 * This is the "body" of the agentic wallet — it can perceive
 * blockchain state and act on it.
 */
import SafeApiKitNS from '@safe-global/api-kit';
import SafeNS from '@safe-global/protocol-kit';
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

// ERC-20 transfer(address,uint256) — used to decode token transfers out of calldata
const ERC20_IFACE = new ethers.Interface([
  'function transfer(address to, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
]);

// ── Chain configs ────────────────────────────────────────────────────────────
export const CHAINS = {
  polygon: {
    chainId:    137n,
    // NB: the previous default `https://polygon-rpc.com` is dead — it now returns
    // HTTP 401 `API key disabled, reason: tenant disabled`. This is the PRODUCTION
    // chain default, so it failed closed but silently, on the path that matters
    // most. publicnode is keyless and live; POLYGON_RPC still overrides.
    rpc:        process.env.POLYGON_RPC || 'https://polygon-bor-rpc.publicnode.com',
    txService:  'https://safe-transaction-polygon.safe.global',
    name:       'Polygon',
  },
  base: {
    chainId:    8453n,
    rpc:        process.env.BASE_RPC || 'https://mainnet.base.org',
    txService:  'https://safe-transaction-base.safe.global',
    name:       'Base',
  },
  ethereum: {
    chainId:    1n,
    rpc:        process.env.ETH_RPC || 'https://eth.llamarpc.com',
    txService:  'https://safe-transaction-mainnet.safe.global',
    name:       'Ethereum',
  },
  sepolia: {
    chainId:    11155111n,
    // NB: the long-standing default `https://rpc.sepolia.org` is dead (returns a
    // Cloudflare 522 / an HTML error page to JSON-RPC POSTs, not a rate limit).
    // publicnode is keyless and live; SEPOLIA_RPC still overrides.
    rpc:        process.env.SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com',
    txService:  'https://safe-transaction-sepolia.safe.global',
    name:       'Sepolia (testnet)',
  },
};

export class SAGEClient {
  /**
   * @param {string} chainKey   - 'polygon' | 'base' | 'ethereum' | 'sepolia'
   * @param {string} safeAddress - the deployed Safe contract address (or null if not yet deployed)
   */
  constructor(chainKey, safeAddress = null) {
    this.chain       = CHAINS[chainKey] || CHAINS.polygon;
    this.safeAddress = safeAddress;
    this.provider    = new ethers.JsonRpcProvider(this.chain.rpc);
    this.apiKit      = new SafeApiKit({ chainId: this.chain.chainId });
  }

  // ── PERCEPTION — what the wallet sees ────────────────────────────────────

  /** List all transactions pending signature on this Safe. */
  async getPendingTransactions() {
    if (!this.safeAddress) throw new Error('No Safe address configured');
    const res = await this.apiKit.getPendingTransactions(this.safeAddress);
    return res.results.map(tx => ({
      safeTxHash:       tx.safeTxHash,
      to:               tx.to,
      value:            tx.value,
      data:             tx.data,
      nonce:            tx.nonce,
      confirmations:    tx.confirmations?.length || 0,
      confirmationsRequired: tx.confirmationsRequired,
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
    return this.apiKit.getSafeInfo(this.safeAddress);
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
    const res = await this.apiKit.getAllTransactions(this.safeAddress, {
      executed: true,
    });
    return res.results.slice(0, limit);
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
    const tx = await this.apiKit.getTransaction(safeTxHash);

    // Decode an ERC-20 transfer out of the calldata where present.
    let erc20 = null;
    if (tx.data && tx.data !== '0x') {
      try {
        const parsed = ERC20_IFACE.parseTransaction({ data: tx.data });
        if (parsed && (parsed.name === 'transfer' || parsed.name === 'transferFrom')) {
          erc20 = {
            token_address:   ethers.getAddress(tx.to),           // the ERC-20 contract
            transfer_to:     parsed.args.to,
            transfer_amount: parsed.args.amount.toString(),      // raw units, no decimals applied
          };
        }
      } catch { /* not an ERC-20 transfer — leave erc20 null */ }
    }

    return {
      safeTxHash,
      to:        tx.to,
      value:     tx.value,        // native value in wei (string)
      data:      tx.data,
      operation: tx.operation,
      nonce:     tx.nonce,
      erc20,
    };
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
    const pending     = await this.apiKit.getTransaction(safeTxHash);

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
    await this.apiKit.confirmTransaction(safeTxHash, signature);

    return { signed: true, safeTxHash, signer: agentWallet.address };
  }

  /**
   * Propose a new transaction to the Safe.
   * @param {object}         tx          - { to, value, data }
   * @param {ethers.Wallet}  agentWallet - the proposing agent
   */
  async proposeTransaction(tx, agentWallet) {
    const protocolKit = await this._protocolKit(agentWallet);

    const safeTx = await protocolKit.createTransaction({
      transactions: [{
        to:        tx.to,
        value:     tx.value || '0',
        data:      tx.data  || '0x',
        operation: 0,   // CALL
      }],
    });

    const safeTxHash = await protocolKit.getTransactionHash(safeTx);
    const signedTx   = await protocolKit.signTransaction(safeTx);

    await this.apiKit.proposeTransaction({
      safeAddress:         this.safeAddress,
      safeTransactionData: signedTx.data,
      safeTxHash,
      senderAddress:       agentWallet.address,
      senderSignature:     signedTx.encodedSignatures(),
    });

    return { proposed: true, safeTxHash };
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

    return {
      safe:    this.safeAddress,
      chain:   this.chain.name,
      info:    info.status    === 'fulfilled' ? info.value    : null,
      pending: pending.status === 'fulfilled' ? pending.value : [],
      recent:  history.status === 'fulfilled' ? history.value : [],
    };
  }
}
