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

const S = { eip1193: null, signer: null, me: null, agents: null, safe: null, queue: [] };

// ── storage (best effort; the demo still works for the session without it) ──
const key = () => `sage-demo:${S.me?.toLowerCase()}`;
function load() { try { return JSON.parse(localStorage.getItem(key()) || 'null'); } catch { return null; } }
function save() {
  try { localStorage.setItem(key(), JSON.stringify({ proposal: S.agents.proposal.privateKey, signer: S.agents.signer.privateKey, safe: S.safe, queue: S.queue })); } catch {}
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
    S.queue = Array.isArray(saved?.queue) ? saved.queue : [];
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
    if (S.safe) { log(`Found your demo Safe from last time: ${addrLink(S.safe)}.`); await showSafe(); await syncQueue(); renderQueue(); step(pendingItems().length ? 5 : 3); }
    else step(2);
  } catch (e) { fail(e, btn); }
}

// Every transaction goes through here. Wallets can drift to another network per site,
// and their own gas estimate then fails with misleading errors ("insufficient funds",
// "missing revert data"). So: re-check the network, estimate on the public Sepolia
// node, and hand the wallet a ready gas limit.
async function ensureChain() {
  let id = await S.eip1193.request({ method: 'eth_chainId' });
  if (id !== '0xaa36a7') {
    log('Your wallet is on another network. Switching it back to Sepolia…', 'warn');
    await S.eip1193.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xaa36a7' }] });
    id = await S.eip1193.request({ method: 'eth_chainId' });
    if (id !== '0xaa36a7') throw new Error('Please switch your wallet to Sepolia and try again.');
  }
  S.signer = await new ethers.BrowserProvider(S.eip1193).getSigner();
  if ((await S.signer.getAddress()).toLowerCase() !== S.me.toLowerCase()) throw new Error('Your wallet switched accounts. Reload the page.');
}
async function sendTx(req) {
  await ensureChain();
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
// The Safe gets the money to play with; the signer agent gets a little gas, because in
// SAGE it is the signer agent that broadcasts once you approve.
const AGENT_GAS = ethers.parseEther('0.0005');
async function fund() {
  const btn = $('btn-fund');
  if (!S.safe) { log(S.agents ? 'Deploy your Safe first (step 2).' : 'Connect your wallet first (step 1).', 'warn'); return; }
  busy(btn, true);
  try {
    const tx = await sendTx({ to: S.safe, value: ethers.parseEther($('fund-amt').value || '0.001') });
    btn.textContent = 'Sending…';
    log(`Funding your Safe: ${txLink(tx.hash)}`);
    await confirmed(tx.hash);
    log('Your Safe is funded.', 'good');
    if ((await reader.getBalance(S.agents.signer.address)) < AGENT_GAS / 2n) {
      btn.textContent = 'Gas for the signer agent…';
      const g = await sendTx({ to: S.agents.signer.address, value: AGENT_GAS });
      log(`Sending the signer agent ${ethers.formatEther(AGENT_GAS)} ETH for gas, so it can broadcast what you approve: ${txLink(g.hash)}`);
      await confirmed(g.hash);
      log('The signer agent has gas.', 'good');
    }
    busy(btn, false);
    await showSafe();
    step(4);
  } catch (e) { fail(e, btn); }
}

// ── 4. propose: the proposal agent adds signature 1 ─────────────────────────
function facts() {
  const f = new FormData($('try-form'));
  const wired = f.get('tmode') === 'wired';
  const now = f.get('hours') ? new Date(Date.UTC(2026, 9, 12, 14, 0)) : new Date(); // Mon 11:00 BRT, or the real clock
  return wired
    ? { value_usd: Number(f.get('usd')), token: 'ETH', now, is_new_address: !f.get('known'),
        kyc_verified: !!f.get('kyc'), aml_clear: !!f.get('aml'), ...(f.get('flag') ? { aml_flagged: true } : {}) }
    : { kyc_verified: false, aml_clear: false, now };   // what sage.js derives today
}

const domain = () => ({ chainId: CHAIN_ID, verifyingContract: S.safe });
const pendingItems = () => S.queue.filter((q) => q.status === 'pending').sort((a, b) => a.nonce - b.nonce);
const sigCount = (q) => Object.keys(q.sigs).length;
const fmtItem = (q) => ({ id: q.id, nonce: q.nonce, to: q.to, amount_eth: q.amount, policy: q.decision, reasons: q.reasons,
  signatures: `${sigCount(q)}/2`, signed_by: Object.keys(q.sigs).map(label), status: q.status, ...(q.tx ? { tx: `${EXPLORER}/tx/${q.tx}` } : {}) });
function label(a) {
  a = a.toLowerCase();
  if (a === S.me?.toLowerCase()) return 'you';
  if (a === S.agents?.proposal.address.toLowerCase()) return 'proposal agent';
  if (a === S.agents?.signer.address.toLowerCase()) return 'signer agent';
  return short(a);
}

async function safeNonce() { return Number(await new ethers.Contract(S.safe, SAFE_ABI, reader).nonce()); }

// Drop what the chain already executed (by us, or anyone) so the queue matches reality.
async function syncQueue() {
  const n = await safeNonce();
  for (const q of S.queue) if (q.status === 'pending' && q.nonce < n) { q.status = 'executed'; }
  save();
  return n;
}

async function proposeMany(list) {
  if (!S.safe) throw new Error('Connect your wallet and deploy your Safe first (steps 1 to 3).');
  const onchain = await syncQueue();
  let nonce = Math.max(onchain, ...pendingItems().map((q) => q.nonce + 1));
  const bal = await reader.getBalance(S.safe);
  const ctx = facts();
  const out = [];
  let total = pendingItems().reduce((t, q) => t + ethers.parseEther(q.amount), 0n);
  for (const it of list) {
    const to = ethers.getAddress(String(it.to || S.me).trim());
    const value = ethers.parseEther(String(it.amountEth || '0.0002'));
    const { decision, reasons } = evaluate({ to, value: value.toString() }, ctx, 'execution');
    if (decision === 'REJECT') {
      // Rejected before anything is signed, and no nonce is taken: a rejected payment
      // must not sit in the queue blocking the ones behind it.
      const q = { id: `r${Date.now().toString(36)}${out.length}`, to, amount: ethers.formatEther(value), decision, reasons, sigs: {}, status: 'rejected' };
      S.queue.push(q); out.push(fmtItem(q));
      log(`Policy says REJECT for ${ethers.formatEther(value)} ETH to ${addrLink(to)}: ${esc(reasons[0])}. Nothing was signed.`, 'bad');
      continue;
    }
    total += value;
    if (total > bal) throw new Error(`Your Safe holds ${ethers.formatEther(bal)} ETH, not enough for ${ethers.formatEther(total)} queued. Fund it first.`);
    const message = { to, value: value.toString(), data: '0x', operation: 0, safeTxGas: 0, baseGas: 0, gasPrice: 0, gasToken: ZERO, refundReceiver: ZERO, nonce };
    const hash = ethers.TypedDataEncoder.hash(domain(), SAFE_TX_TYPES, message);
    const sigs = { [S.agents.proposal.address]: S.agents.proposal.signingKey.sign(hash).serialized };
    const q = { id: hash.slice(2, 8), hash, nonce, to, amount: ethers.formatEther(value), message, sigs, decision, reasons, status: 'pending' };
    if (decision === 'AUTO_SIGN') {
      sigs[S.agents.signer.address] = S.agents.signer.signingKey.sign(hash).serialized;
      log(`#${nonce}: ${q.amount} ETH to ${addrLink(to)}. AUTO_SIGN: inside every limit, so both agents signed (2 of 2).`, 'good');
    } else {
      log(`#${nonce}: ${q.amount} ETH to ${addrLink(to)}. Proposal agent signed (1 of 2). HOLD_HUMAN: ${esc(reasons[0])}. Waiting for your review.`, 'warn');
    }
    S.queue.push(q); out.push(fmtItem(q));
    nonce++;
  }
  save();
  renderQueue();
  step(5);
  $('try-queue-step').scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  return { proposed: out, next: 'Review the queue on the page. Then sign any of them with your wallet, or say "sign them all, I have reviewed" and the signer agent will sign and send them.' };
}

async function propose(opts = {}) {
  const btn = $('btn-propose');
  try {
    if (opts.to !== undefined) $('to').value = opts.to;
    if (opts.amountEth !== undefined) $('amt').value = String(opts.amountEth);
    return await proposeMany([{ to: $('to').value || S.me, amountEth: $('amt').value || '0.0002' }]);
  } catch (e) { fail(e, btn); throw e; }
}

// ── 5. review: you sign, or you tell the signer agent to ────────────────────
async function signMine(id) {
  const q = S.queue.find((x) => x.id === id && x.status === 'pending');
  const btn = document.querySelector(`[data-sign="${id}"]`);
  if (!q) return;
  if (btn) busy(btn, true);
  try {
    await ensureChain();
    const sig = await S.signer.signTypedData(domain(), SAFE_TX_TYPES, q.message);
    if (ethers.verifyTypedData(domain(), SAFE_TX_TYPES, q.message, sig) !== S.me) throw new Error('Wallet signature did not recover to your address.');
    q.sigs[S.me] = sig;
    save();
    log(`You signed #${q.nonce} from your wallet: 2 of 2. It's ready to send.`, 'good');
    renderQueue();
  } catch (e) { fail(e, btn); }
}

function execData(q) {
  const m = q.message;
  // The Safe wants signatures ordered by owner address, ascending.
  const packed = '0x' + Object.keys(q.sigs).sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)).map((a) => q.sigs[a].slice(2)).join('');
  return new ethers.Interface(SAFE_ABI).encodeFunctionData('execTransaction', [m.to, m.value, m.data, m.operation, m.safeTxGas, m.baseGas, m.gasPrice, m.gasToken, m.refundReceiver, packed]);
}

// Broadcast one fully signed item. The signer agent pays gas when it can; otherwise your wallet does.
async function broadcast(q, by = 'agent') {
  const data = execData(q);
  let tx;
  const agent = S.agents.signer.connect(reader);
  if (by === 'agent') {
    const est = await reader.estimateGas({ from: agent.address, to: S.safe, data }).catch((e) => { throw new Error(`#${q.nonce} would fail on Sepolia: ${e.shortMessage || e.message}`); });
    const fee = await reader.getFeeData();
    if ((await reader.getBalance(agent.address)) >= est * 13n / 10n * (fee.maxFeePerGas || fee.gasPrice || 0n)) {
      tx = await agent.sendTransaction({ to: S.safe, data, gasLimit: est * 13n / 10n });
      log(`Signer agent broadcast #${q.nonce}: ${txLink(tx.hash)}`);
    } else {
      log('The signer agent has no gas left, so your wallet sends it.', 'warn');
    }
  }
  if (!tx) { tx = await sendTx({ to: S.safe, data }); log(`You broadcast #${q.nonce}: ${txLink(tx.hash)}`); }
  const rc = await confirmed(tx.hash);
  const ok = rc.logs.some((l) => l.address.toLowerCase() === S.safe.toLowerCase() && l.topics[0] === ethers.id('ExecutionSuccess(bytes32,uint256)') && l.topics[1] === q.hash);
  if (!ok) throw new Error(`#${q.nonce}: the Safe did not report ExecutionSuccess.`);
  q.status = 'executed'; q.tx = tx.hash; save();
  log(`Executed #${q.nonce} on Sepolia: ${q.amount} ETH to ${addrLink(q.to)}. ${txLink(tx.hash)}`, 'good');
  return fmtItem(q);
}

async function sendMine(id) {
  const q = S.queue.find((x) => x.id === id && x.status === 'pending');
  const btn = document.querySelector(`[data-send="${id}"]`);
  if (!q) return;
  if (btn) busy(btn, true);
  try {
    if (pendingItems()[0]?.id !== q.id) throw new Error(`#${q.nonce} has to wait: a Safe sends strictly in nonce order. Send #${pendingItems()[0].nonce} first.`);
    await broadcast(q, 'wallet');
    await showSafe(); renderQueue();
  } catch (e) { fail(e, btn); }
}

// "Sign them all, I have reviewed": your instruction is the human OK. The signer agent adds
// signature 2 to every pending payment (a HOLD it signs on your say-so is recorded as your
// override), then broadcasts them in nonce order. A REJECT never reaches the queue.
async function approveAll() {
  const btn = $('btn-approve-all');
  if (btn) busy(btn, true, 'Signing and sending…');
  try {
    await syncQueue();
    const items = pendingItems();
    if (!items.length) throw new Error('Nothing is waiting in the queue. Propose a payment first.');
    const results = [];
    for (const q of items) {
      const r = { nonce: q.nonce, to: q.to, amount_eth: q.amount, policy: q.decision };
      try {
        if (sigCount(q) < 2) {
          q.sigs[S.agents.signer.address] = S.agents.signer.signingKey.sign(q.hash).serialized;
          q.overrodeHold = q.decision === 'HOLD_HUMAN';
          save();
          log(`Signer agent signed #${q.nonce} (2 of 2)${q.overrodeHold ? `, authorized by you (${short(S.me)}) over its HOLD` : ''}.`, 'good');
        }
        Object.assign(r, await broadcast(q, 'agent'), { authorized_by: S.me, overrode_hold: !!q.overrodeHold });
      } catch (e) {
        r.status = 'error'; r.error = e.shortMessage || e.message;
        log(`#${q.nonce}: ${esc(r.error)}`, 'bad');
        results.push(r);
        break;   // strict nonce order: nothing behind a failed one can execute
      }
      results.push(r);
      renderQueue();
    }
    await showSafe(); renderQueue();
    if (btn) busy(btn, false);
    return { operator: S.me, results };
  } catch (e) { fail(e, btn); throw e; }
}

function renderQueue() {
  const items = S.queue.slice().sort((a, b) => (a.nonce ?? 1e9) - (b.nonce ?? 1e9)).slice(-12);
  $('try-queue-step').hidden = !items.length;
  const head = pendingItems()[0]?.id;
  $('try-queue').innerHTML = items.map((q) => {
    const badge = { AUTO_SIGN: 'v-auto', HOLD_HUMAN: 'v-hold', REJECT: 'v-rej' }[q.decision];
    const mine = q.sigs[S.me];
    let act = '';
    if (q.status === 'pending') {
      if (!mine && sigCount(q) < 2) act += `<button class="btn btn-ghost sm" data-sign="${q.id}">Sign with my wallet</button>`;
      if (sigCount(q) >= 2) act += q.id === head ? `<button class="btn btn-ghost sm" data-send="${q.id}">Send from my wallet</button>` : `<span class="muted-note">waits for #${pendingItems()[0].nonce}</span>`;
    }
    const st = q.status === 'executed' ? `<a href="${EXPLORER}/tx/${q.tx || ''}" target="_blank" rel="noopener" class="st ok">executed ↗</a>`
      : q.status === 'rejected' ? '<span class="st bad">rejected, nothing signed</span>' : `<span class="st">${sigCount(q)}/2 signed</span>`;
    return `<div class="qrow ${q.status}">
      <span class="mono qn">${q.nonce !== undefined ? '#' + q.nonce : '–'}</span>
      <div class="qmain"><b>${esc(q.amount)} ETH → ${addrLink(q.to)}</b>
        <small><span class="v-chip ${badge}">${q.decision}</span> ${esc(q.reasons[0] || '')}</small>
        <small>signed by: ${Object.keys(q.sigs).map(label).join(', ') || 'nobody'}</small></div>
      <div class="qside">${st}${act}</div></div>`;
  }).join('');
  const n = pendingItems().length;
  $('btn-approve-all').disabled = !n;
  $('btn-approve-all').textContent = n ? `Approve all ${n}: signer agent signs and sends` : 'Nothing waiting';
}
$('try-queue').addEventListener('click', (e) => {
  const s = e.target.closest('[data-sign]'); if (s) return signMine(s.dataset.sign);
  const d = e.target.closest('[data-send]'); if (d) return sendMine(d.dataset.send);
});

function reset() {
  if (!S.me) return;
  try { localStorage.removeItem(key()); } catch {}
  location.reload();
}

$('btn-connect').addEventListener('click', connect);
$('btn-deploy').addEventListener('click', deploy);
$('btn-fund').addEventListener('click', fund);
$('btn-propose').addEventListener('click', (e) => { e.preventDefault(); propose().catch(() => {}); });
$('btn-approve-all').addEventListener('click', () => approveAll().catch(() => {}));
$('btn-reset').addEventListener('click', reset);
document.querySelectorAll('input[name=tmode]').forEach((r) => r.addEventListener('change', () =>
  $('try-facts').classList.toggle('muted', new FormData($('try-form')).get('tmode') !== 'wired')));
step(1);

// Interface for the chat assistant (chat.js): the same actions as the buttons. Your own
// wallet signature stays a click; "approve all" is the signer agent acting on your word.
async function state() {
  if (!S.me) return { connected: false, next: 'Click "Connect wallet" in step 1.' };
  const out = { connected: true, wallet: S.me, agents: { proposal: S.agents.proposal.address, signer: S.agents.signer.address }, safe: S.safe };
  if (S.safe) {
    const c = new ethers.Contract(S.safe, SAFE_ABI, reader);
    const [bal, nonce, thr, gas] = await Promise.all([reader.getBalance(S.safe), c.nonce(), c.getThreshold(), reader.getBalance(S.agents.signer.address)]);
    Object.assign(out, { threshold: `${thr}-of-3`, balance_eth: ethers.formatEther(bal), nonce: Number(nonce), signer_agent_gas_eth: ethers.formatEther(gas) });
    await syncQueue();
    out.queue = S.queue.slice(-12).map(fmtItem);
  } else out.next = 'Click "Deploy Safe" in step 2.';
  out.what_sage_knows = facts();
  return out;
}
window.sageDemo = { state, propose, proposeMany: (list) => proposeMany(list.map((x) => ({ to: x.to, amountEth: x.amount_eth ?? x.amountEth }))),
  approveAll, queue: async () => { if (S.safe) await syncQueue(); return S.queue.slice(-12).map(fmtItem); }, facts };
