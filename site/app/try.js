// "Try it with your wallet": deploy your own 2-of-3 Safe on Sepolia with two demo agents,
// propose a transfer, let the real policy engine decide, co-sign, execute on chain.
//
// The two demo agents run in this browser tab with throwaway keys kept in localStorage.
// In SAGE they run in your MCP server, with keys held by a vault. Everything the user
// sends is paid for and signed by their own wallet; nothing goes to a server of ours.
import { ethers } from 'https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.min.js';
import { evaluate } from './policyEngine.js';

const CHAIN_ID = 11155111n;
const RPC = new URLSearchParams(location.search).get('rpc') || 'https://ethereum-sepolia-rpc.publicnode.com';
const EXPLORER = 'https://sepolia.etherscan.io';
// Canonical Safe 1.4.1 deployments (same contracts the live SAGE Safe uses).
const FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67';
const SINGLETON_L2 = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762';
const FALLBACK = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99';
const ZERO = ethers.ZeroAddress;
const SAFE_ABI = [
  'function setup(address[] _owners,uint256 _threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)',
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)',
  'function nonce() view returns (uint256)', 'function getThreshold() view returns (uint256)', 'function getOwners() view returns (address[])',
  'event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)', 'event ExecutionFailure(bytes32 indexed txHash, uint256 payment)',
];
const FACTORY_ABI = ['function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address)',
  'event ProxyCreation(address indexed proxy, address singleton)'];
const SAFE_TX_TYPES = { SafeTx: [
  { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
  { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
  { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' },
  { name: 'nonce', type: 'uint256' }] };

const $ = (id) => document.getElementById(id);
const short = (a) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const reader = new ethers.JsonRpcProvider(RPC, Number(CHAIN_ID), { staticNetwork: true });

// Wallets poll for receipts slowly (or not at all once the popup closes), so confirm on
// the public node instead, and say so plainly if Sepolia is slow.
async function confirmed(hash) {
  const rc = await reader.waitForTransaction(hash, 1, 240_000);
  if (!rc) throw new Error(`Still pending after 4 minutes. Check it on Etherscan: ${EXPLORER}/tx/${hash}`);
  if (rc.status === 0) throw new Error(`The transaction reverted: ${EXPLORER}/tx/${hash}`);
  return rc;
}

const S = { eip1193: null, signer: null, me: null, agents: null, safe: null, pending: null };

// ── storage (best effort; the demo still works for the session without it) ──
const key = () => `sage-demo:${S.me?.toLowerCase()}`;
function load() { try { return JSON.parse(localStorage.getItem(key()) || 'null'); } catch { return null; } }
function save() {
  try { localStorage.setItem(key(), JSON.stringify({ proposal: S.agents.proposal.privateKey, signer: S.agents.signer.privateKey, safe: S.safe })); } catch {}
}

function log(html, cls = '') {
  const li = document.createElement('li');
  li.className = cls;
  li.innerHTML = `<time>${new Date().toLocaleTimeString()}</time><span>${html}</span>`;
  $('try-log').prepend(li);
}
const txLink = (h) => `<a href="${EXPLORER}/tx/${h}" target="_blank" rel="noopener">${short(h)} ↗</a>`;
const addrLink = (a) => `<a class="mono" href="${EXPLORER}/address/${a}" target="_blank" rel="noopener">${short(a)}</a>`;
function busy(btn, on, text) {
  btn.disabled = on;
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = text || 'Waiting for wallet…'; }
  else if (btn.dataset.label) btn.textContent = btn.dataset.label;
}
function fail(e, btn) {
  if (btn) busy(btn, false);
  const msg = e?.shortMessage || e?.info?.error?.message || e?.message || String(e);
  log(/user (rejected|denied)|ACTION_REJECTED/i.test(msg) ? 'You cancelled in your wallet.'
    : /insufficient funds|missing revert data/i.test(msg) ? `Your wallet rejected it (${esc(msg)}). Check that it is on Sepolia and has test ETH, then try again.`
    : `Error: ${esc(msg)}`, 'bad');
}
function step(n) {
  // A step's button only works once the steps before it are done.
  if ($('btn-deploy').textContent !== 'Deployed') $('btn-deploy').disabled = n < 2;
  $('btn-fund').disabled = n < 3;
  $('btn-propose').disabled = n < 3;
  document.querySelectorAll('.try-step').forEach((el) => {
    const k = Number(el.dataset.step);
    el.classList.toggle('done', k < n);
    el.classList.toggle('active', k === n);
  });
}

// ── 1. connect ──────────────────────────────────────────────────────────────
const announced = [];
window.addEventListener('eip6963:announceProvider', (e) => announced.push(e.detail));
window.dispatchEvent(new Event('eip6963:requestProvider'));

async function connect() {
  const btn = $('btn-connect');
  const pick = announced.find((p) => p.info.rdns === 'io.metamask') || announced[0];
  S.eip1193 = pick?.provider || window.ethereum;
  S.walletName = pick?.info?.name || (window.ethereum?.isBraveWallet ? 'Brave Wallet' : window.ethereum?.isMetaMask ? 'MetaMask' : 'your browser wallet');
  if (!S.eip1193) {
    log('No wallet found. Install <a href="https://metamask.io" target="_blank" rel="noopener">MetaMask</a> or another browser wallet, then reload.', 'bad');
    return;
  }
  busy(btn, true);
  try {
    await S.eip1193.request({ method: 'eth_requestAccounts' });
    try {
      await S.eip1193.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xaa36a7' }] });
    } catch (e) {
      if (e.code !== 4902) throw e;
      await S.eip1193.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0xaa36a7', chainName: 'Sepolia',
        nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: [RPC], blockExplorerUrls: [EXPLORER] }] });
    }
    const bp = new ethers.BrowserProvider(S.eip1193);
    if ((await bp.getNetwork()).chainId !== CHAIN_ID) throw new Error('Please switch your wallet to Sepolia.');
    S.signer = await bp.getSigner();
    S.me = await S.signer.getAddress();
    S.eip1193.on?.('accountsChanged', () => location.reload());
    S.eip1193.on?.('chainChanged', () => location.reload());

    const saved = load();
    S.agents = {
      proposal: new ethers.Wallet(saved?.proposal || ethers.Wallet.createRandom().privateKey),
      signer: new ethers.Wallet(saved?.signer || ethers.Wallet.createRandom().privateKey),
    };
    S.safe = saved?.safe || null;
    save();
    $('agent-p').innerHTML = addrLink(S.agents.proposal.address);
    $('agent-s').innerHTML = addrLink(S.agents.signer.address);
    $('me').innerHTML = addrLink(S.me);
    btn.textContent = 'Connected';
    step(S.safe ? 3 : 2);
    const bal = await reader.getBalance(S.me);
    $('me').innerHTML = `${addrLink(S.me)} · ${Number(ethers.formatEther(bal)).toFixed(4)} Sepolia ETH`;
    log(`Connected ${esc(S.walletName)} account ${addrLink(S.me)}. Two demo agents created in this tab. Wrong account? Switch it in your wallet; this page follows.`);
    if (bal < ethers.parseEther('0.003')) {
      log(`This account has ${Number(ethers.formatEther(bal)).toFixed(4)} Sepolia ETH. If your test ETH is in another account, switch to it in ${esc(S.walletName)}.`, 'warn');
      log('You need a little Sepolia ETH for gas (about 0.003). Free faucets: <a href="https://cloud.google.com/application/web3/faucet/ethereum/sepolia" target="_blank" rel="noopener">Google</a>, <a href="https://www.alchemy.com/faucets/ethereum-sepolia" target="_blank" rel="noopener">Alchemy</a>.', 'warn');
    }
    if (S.safe) { log(`Found your demo Safe from last time: ${addrLink(S.safe)}.`); await showSafe(); step(3); }
    else step(2);
  } catch (e) { fail(e, btn); }
}

// Every transaction goes through here. Wallets can drift to another network per site,
// and their own gas estimate then fails with misleading errors ("insufficient funds",
// "missing revert data"). So: re-check the network, estimate on the public Sepolia
// node, and hand the wallet a ready gas limit.
async function sendTx(req) {
  let id = await S.eip1193.request({ method: 'eth_chainId' });
  if (id !== '0xaa36a7') {
    log('Your wallet is on another network. Switching it back to Sepolia…', 'warn');
    await S.eip1193.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xaa36a7' }] });
    id = await S.eip1193.request({ method: 'eth_chainId' });
    if (id !== '0xaa36a7') throw new Error('Please switch your wallet to Sepolia and try again.');
  }
  S.signer = await new ethers.BrowserProvider(S.eip1193).getSigner();
  if ((await S.signer.getAddress()).toLowerCase() !== S.me.toLowerCase()) throw new Error('Your wallet switched accounts. Reload the page.');
  const full = { from: S.me, to: req.to, data: req.data || '0x', value: req.value || 0n };
  const [bal, est] = await Promise.all([reader.getBalance(S.me), reader.estimateGas(full).catch((e) => { throw new Error(`This would fail on Sepolia: ${e.shortMessage || e.message}`); })]);
  const fee = await reader.getFeeData();
  const need = est * 13n / 10n * (fee.maxFeePerGas || fee.gasPrice || 0n) + (req.value || 0n);
  if (bal < need) throw new Error(`The connected account ${short(S.me)} (${S.walletName}) has ${ethers.formatEther(bal)} Sepolia ETH; this needs about ${Number(ethers.formatEther(need)).toPrecision(2)}. If your test ETH is in another account, switch to it in your wallet. Otherwise get some from a faucet.`);
  return S.signer.sendTransaction({ to: req.to, data: full.data, value: full.value, gasLimit: est * 13n / 10n });
}

// ── 2. deploy ───────────────────────────────────────────────────────────────
async function deploy() {
  const btn = $('btn-deploy');
  if (!S.agents) { log('Connect your wallet first (step 1).', 'warn'); return; }
  busy(btn, true);
  try {
    const owners = [S.me, S.agents.proposal.address, S.agents.signer.address];
    const init = new ethers.Interface(SAFE_ABI).encodeFunctionData('setup', [owners, 2, ZERO, '0x', FALLBACK, ZERO, 0, ZERO]);
    const factory = new ethers.Contract(FACTORY, FACTORY_ABI, reader);
    const tx = await sendTx({ to: FACTORY, data: factory.interface.encodeFunctionData('createProxyWithNonce', [SINGLETON_L2, init, BigInt(Date.now())]) });
    btn.textContent = 'Deploying…';
    log(`Deploying your Safe: ${txLink(tx.hash)}`);
    const rc = await confirmed(tx.hash);
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((x) => x?.name === 'ProxyCreation');
    S.safe = ethers.getAddress(ev.args.proxy);
    save();
    log(`Safe deployed at ${addrLink(S.safe)}: you, the proposal agent and the signer agent, any 2 of 3.`, 'good');
    btn.textContent = 'Deployed';
    await showSafe();
    step(3);
  } catch (e) { fail(e, btn); }
}

async function showSafe() {
  const c = new ethers.Contract(S.safe, SAFE_ABI, reader);
  const [bal, nonce, thr] = await Promise.all([reader.getBalance(S.safe), c.nonce(), c.getThreshold()]);
  $('my-safe').innerHTML = `${addrLink(S.safe)} · ${thr}-of-3 · ${ethers.formatEther(bal)} ETH · nonce ${nonce}`;
  $('btn-deploy').disabled = true;
  $('btn-deploy').textContent = 'Deployed';
  return { bal, nonce };
}

// ── 3. fund ─────────────────────────────────────────────────────────────────
async function fund() {
  const btn = $('btn-fund');
  if (!S.safe) { log(S.agents ? 'Deploy your Safe first (step 2).' : 'Connect your wallet first (step 1).', 'warn'); return; }
  busy(btn, true);
  try {
    const tx = await sendTx({ to: S.safe, value: ethers.parseEther($('fund-amt').value || '0.001') });
    btn.textContent = 'Sending…';
    log(`Funding your Safe: ${txLink(tx.hash)}`);
    await confirmed(tx.hash);
    busy(btn, false);
    log('Your Safe is funded.', 'good');
    await showSafe();
    step(4);
  } catch (e) { fail(e, btn); }
}

// ── 4. propose + decide ─────────────────────────────────────────────────────
function facts() {
  const f = new FormData($('try-form'));
  const wired = f.get('tmode') === 'wired';
  const now = f.get('hours') ? new Date(Date.UTC(2026, 9, 12, 14, 0)) : new Date(); // Mon 11:00 BRT, or the real clock
  return wired
    ? { value_usd: Number(f.get('usd')), token: 'ETH', now, is_new_address: !f.get('known'),
        kyc_verified: !!f.get('kyc'), aml_clear: !!f.get('aml'), ...(f.get('flag') ? { aml_flagged: true } : {}) }
    : { kyc_verified: false, aml_clear: false, now };   // what sage.js derives today
}

async function propose(opts = {}) {
  const btn = $('btn-propose');
  try {
    if (!S.safe) throw new Error('Connect your wallet and deploy your Safe first (steps 1 to 3).');
    if (opts.to !== undefined) $('to').value = opts.to;
    if (opts.amountEth !== undefined) $('amt').value = String(opts.amountEth);
    const to = ethers.getAddress(($('to').value || S.me).trim());
    const value = ethers.parseEther($('amt').value || '0.0002');
    const { bal, nonce } = await showSafe();
    if (bal < value) throw new Error(`Your Safe holds ${ethers.formatEther(bal)} ETH, less than ${ethers.formatEther(value)}. Fund it first.`);
    const message = { to, value, data: '0x', operation: 0, safeTxGas: 0, baseGas: 0, gasPrice: 0, gasToken: ZERO, refundReceiver: ZERO, nonce };
    const domain = { chainId: CHAIN_ID, verifyingContract: S.safe };
    const hash = ethers.TypedDataEncoder.hash(domain, SAFE_TX_TYPES, message);
    const sigs = { [S.agents.proposal.address]: S.agents.proposal.signingKey.sign(hash).serialized };
    log(`Proposal agent proposed ${ethers.formatEther(value)} ETH to ${addrLink(to)} and added signature 1 of 2.`);

    const ctx = facts();
    const { decision, reasons } = evaluate({ to, value: value.toString() }, ctx, 'execution');
    S.pending = { message, domain, hash, sigs, decision };
    const badge = $('try-badge');
    badge.textContent = decision;
    badge.className = 'v-badge ' + { AUTO_SIGN: 'v-auto', HOLD_HUMAN: 'v-hold', REJECT: 'v-rej' }[decision];
    $('try-reasons').innerHTML = reasons.map((r) => `<li>${esc(r)}</li>`).join('');
    $('try-decision').hidden = false;

    if (decision === 'AUTO_SIGN') {
      sigs[S.agents.signer.address] = S.agents.signer.signingKey.sign(hash).serialized;
      log('Policy says AUTO_SIGN. The signer agent co-signed on its own: 2 of 2. Ready to execute.', 'good');
      $('try-next').innerHTML = '<p>The agents agree and the policy allows it. Anyone can now submit it; your wallet pays the gas.</p><button class="btn btn-green" id="btn-exec">Execute on chain</button>';
    } else if (decision === 'HOLD_HUMAN') {
      log(`Policy says HOLD_HUMAN: ${esc(reasons[0])}. The signer agent refuses. It needs you.`, 'warn');
      $('try-next').innerHTML = '<p>The signer agent won\'t sign this. You are the other owner: review it, then add your signature from your wallet.</p><button class="btn btn-green" id="btn-cosign">Co-sign with my wallet</button>';
    } else {
      log(`Policy says REJECT: ${esc(reasons[0])}. Nothing will be signed.`, 'bad');
      $('try-next').innerHTML = '<p>Rejected outright. Even an operator\'s "approve all" can\'t override an AML flag. Nothing was signed beyond the proposal, and no funds moved.</p>';
    }
    $('btn-exec')?.addEventListener('click', () => execute().catch(() => {}));
    $('btn-cosign')?.addEventListener('click', cosign);
    step(5);
    $('try-decision').scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    return { decision, reasons, safe: S.safe, nonce: Number(nonce), to, amount_eth: ethers.formatEther(value),
      signatures: Object.keys(sigs).length, needed: 2,
      next: { AUTO_SIGN: 'Both agents signed. The user can execute it (their wallet pays gas).',
              HOLD_HUMAN: 'The signer agent refused. The user must review and click "Co-sign with my wallet" on the page; the assistant cannot sign.',
              REJECT: 'Rejected. Nothing more will be signed.' }[decision] };
  } catch (e) { fail(e, btn); throw e; }
}

async function cosign() {
  const btn = $('btn-cosign');
  busy(btn, true);
  try {
    const { domain, message, sigs } = S.pending;
    const sig = await S.signer.signTypedData(domain, SAFE_TX_TYPES, message);
    if (ethers.verifyTypedData(domain, SAFE_TX_TYPES, message, sig) !== S.me) throw new Error('Wallet signature did not recover to your address.');
    sigs[S.me] = sig;
    log('You co-signed from your wallet: 2 of 2.', 'good');
    btn.remove();
    $('try-next').insertAdjacentHTML('beforeend', '<button class="btn btn-green" id="btn-exec">Execute on chain</button>');
    $('btn-exec').addEventListener('click', () => execute().catch(() => {}));
  } catch (e) { fail(e, btn); }
}

async function execute() {
  const btn = $('btn-exec');
  if (btn) busy(btn, true);
  try {
    if (!S.pending) throw new Error('Nothing is waiting to execute. Propose a payment first.');
    if (Object.keys(S.pending.sigs).length < 2) throw new Error('Only 1 of 2 signatures so far. The user must click "Co-sign with my wallet" first.');
    const { message: m, sigs, hash } = S.pending;
    // The Safe requires signatures ordered by owner address, ascending.
    const packed = '0x' + Object.keys(sigs).sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)).map((a) => sigs[a].slice(2)).join('');
    const data = new ethers.Interface(SAFE_ABI).encodeFunctionData('execTransaction', [m.to, m.value, m.data, m.operation, m.safeTxGas, m.baseGas, m.gasPrice, m.gasToken, m.refundReceiver, packed]);
    const tx = await sendTx({ to: S.safe, data });
    if (btn) btn.textContent = 'Executing…';
    log(`Submitted: ${txLink(tx.hash)}`);
    const rc = await confirmed(tx.hash);
    const ok = rc.logs.some((l) => l.address.toLowerCase() === S.safe.toLowerCase() && l.topics[0] === ethers.id('ExecutionSuccess(bytes32,uint256)') && l.topics[1] === hash);
    if (!ok) throw new Error('The Safe did not report ExecutionSuccess.');
    log(`Executed on Sepolia. ${ethers.formatEther(m.value)} ETH moved to ${addrLink(m.to)}. ${txLink(tx.hash)}`, 'good');
    if (btn) btn.textContent = 'Done ✓';
    S.pending = null;
    await showSafe();
    step(6);
    return { executed: true, tx: tx.hash, explorer: `${EXPLORER}/tx/${tx.hash}`, amount_eth: ethers.formatEther(m.value), to: m.to };
  } catch (e) { fail(e, btn); throw e; }
}

function reset() {
  if (!S.me) return;
  try { localStorage.removeItem(key()); } catch {}
  location.reload();
}

$('btn-connect').addEventListener('click', connect);
$('btn-deploy').addEventListener('click', deploy);
$('btn-fund').addEventListener('click', fund);
$('btn-propose').addEventListener('click', (e) => { e.preventDefault(); propose().catch(() => {}); });
$('btn-reset').addEventListener('click', reset);
document.querySelectorAll('input[name=tmode]').forEach((r) => r.addEventListener('change', () =>
  $('try-facts').classList.toggle('muted', new FormData($('try-form')).get('tmode') !== 'wired')));
step(1);

// Interface for the chat assistant (chat.js). It can read state, propose and execute,
// exactly like the buttons. It cannot co-sign: that stays a click plus a wallet prompt.
async function state() {
  if (!S.me) return { connected: false, next: 'Click "Connect wallet" in step 1.' };
  const out = { connected: true, wallet: S.me, agents: { proposal: S.agents.proposal.address, signer: S.agents.signer.address }, safe: S.safe };
  if (S.safe) {
    const c = new ethers.Contract(S.safe, SAFE_ABI, reader);
    const [bal, nonce, thr] = await Promise.all([reader.getBalance(S.safe), c.nonce(), c.getThreshold()]);
    Object.assign(out, { threshold: `${thr}-of-3`, balance_eth: ethers.formatEther(bal), nonce: Number(nonce) });
  } else out.next = 'Click "Deploy Safe" in step 2.';
  out.what_sage_knows = facts();
  if (S.pending) out.pending = { to: S.pending.message.to, amount_eth: ethers.formatEther(S.pending.message.value),
    decision: S.pending.decision, signatures: Object.keys(S.pending.sigs).length, needed: 2 };
  return out;
}
window.sageDemo = { state, propose, execute, facts };

