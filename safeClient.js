/**
 * SAGE — Safe Client
 *
 * Wraps @safe-global/protocol-kit and @safe-global/api-kit.
 * This is the "body" of the agentic wallet — it can perceive
 * blockchain state and act on it.
 */
import SafeApiKit from '@safe-global/api-kit';
import { ethers } from 'ethers';

// ── Chain configs ────────────────────────────────────────────────────────────
export const CHAINS = {
  polygon: {
    chainId:    137n,
    rpc:        process.env.POLYGON_RPC || 'https://polygon-rpc.com',
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
    rpc:        process.env.SEPOLIA_RPC || 'https://rpc.sepolia.org',
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
    this.apiKit      = new SafeApiKit.default({ chainId: this.chain.chainId });
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

  /** Get the current Safe balance (native token + ERC-20s). */
  async getBalance() {
    if (!this.safeAddress) throw new Error('No Safe address configured');
    const balances = await this.apiKit.getUsdBalances(this.safeAddress);
    return balances;
  }

  /** Get Safe metadata: owners, threshold, nonce. */
  async getSafeInfo() {
    if (!this.safeAddress) throw new Error('No Safe address configured');
    return this.apiKit.getSafeInfo(this.safeAddress);
  }

  /** Get transaction history (executed txs). */
  async getHistory(limit = 20) {
    if (!this.safeAddress) throw new Error('No Safe address configured');
    const res = await this.apiKit.getAllTransactions(this.safeAddress, {
      executed: true, limit,
    });
    return res.results;
  }

  // ── ACTION — what the wallet does ─────────────────────────────────────────

  /**
   * Sign a pending transaction as an agent.
   * @param {string}         safeTxHash  - hash of the pending tx
   * @param {ethers.Wallet}  agentWallet - the agent's signer
   */
  async signTransaction(safeTxHash, agentWallet) {
    // We use the Safe Transaction Service to add a signature
    // The agent signs the tx hash with its private key
    const signature = await agentWallet.signMessage(ethers.getBytes(safeTxHash));
    await this.apiKit.confirmTransaction(safeTxHash, signature);
    return { signed: true, safeTxHash, signer: agentWallet.address };
  }

  /**
   * Propose a new transaction to the Safe.
   * @param {object}         tx          - { to, value, data }
   * @param {ethers.Wallet}  agentWallet - the proposing agent
   */
  async proposeTransaction(tx, agentWallet) {
    const safeInfo = await this.getSafeInfo();
    const nonce    = safeInfo.nonce;

    // Build the Safe transaction object
    const safeTx = {
      to:             tx.to,
      value:          tx.value || '0',
      data:           tx.data  || '0x',
      operation:      0,   // CALL
      safeTxGas:      0,
      baseGas:        0,
      gasPrice:       0,
      gasToken:       ethers.ZeroAddress,
      refundReceiver: ethers.ZeroAddress,
      nonce,
    };

    // Compute the Safe tx hash
    const safeTxHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['address','uint256','bytes','uint8','uint256','uint256','uint256','address','address','uint256'],
        [safeTx.to, safeTx.value, safeTx.data, safeTx.operation,
         safeTx.safeTxGas, safeTx.baseGas, safeTx.gasPrice,
         safeTx.gasToken, safeTx.refundReceiver, safeTx.nonce]
      )
    );

    const signature = await agentWallet.signMessage(ethers.getBytes(safeTxHash));

    await this.apiKit.proposeTransaction({
      safeAddress:      this.safeAddress,
      safeTransactionData: safeTx,
      safeTxHash,
      senderAddress:    agentWallet.address,
      senderSignature:  signature,
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
