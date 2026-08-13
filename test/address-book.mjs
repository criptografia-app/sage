/**
 * Offline tests for the address book resolver (addressBook.js).
 *
 * Proves the proposal agent turns a human reference into the RIGHT checksummed
 * address, and fails loudly rather than silently sending funds to the wrong
 * place. ENS forward/reverse resolution is exercised with a mock provider (no
 * network); the sync book resolution needs neither network nor files.
 *
 * Run: node test/address-book.mjs   (or `npm test`)
 */
import { resolveRecipient, resolveRecipientAsync, reverseEns, looksLikeEns, listContacts } from '../addressBook.js';
import { ethers } from 'ethers';

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';
const book = { contacts: [
  { name: 'Treasury cold', address: A },
  { name: 'Acme Corp',     address: B },
  { name: 'Acme Payroll',  address: C },
] };

// ── literal address passes through, checksummed ───────────────────────────────
check('literal lowercase address → checksummed, source=literal', (() => {
  const r = resolveRecipient(A.toLowerCase(), book);
  return r.address === ethers.getAddress(A) && r.source === 'literal';
})());

// ── 1-based index ─────────────────────────────────────────────────────────────
check('index "1" → first contact', resolveRecipient('1', book).address === A);
check('index 3 (number) → third contact', resolveRecipient(3, book).address === C);
check('index out of range falls through to name-miss → throws', (() => {
  try { resolveRecipient('9', book); return false; } catch { return true; }
})());

// ── exact name (case-insensitive) ─────────────────────────────────────────────
check('exact name case-insensitive → address', resolveRecipient('treasury cold', book).address === A);

// ── prefix: unique vs ambiguous ───────────────────────────────────────────────
check('exact name wins over being a prefix of others ("Acme Corp")',
  resolveRecipient('Acme Corp', book).address === B);
check('ambiguous prefix "Acme" → throws with both names', (() => {
  try { resolveRecipient('Acme', book); return false; }
  catch (e) { return /ambiguous/i.test(e.message) && /Acme Corp/.test(e.message) && /Acme Payroll/.test(e.message); }
})());
check('unique prefix "Trea" → Treasury cold', resolveRecipient('Trea', book).address === A);

// ── no match ──────────────────────────────────────────────────────────────────
check('unknown name → throws "no contact"', (() => {
  try { resolveRecipient('nobody', book); return false; }
  catch (e) { return /no contact/i.test(e.message); }
})());

// ── looksLikeEns ──────────────────────────────────────────────────────────────
check('vitalik.eth looks like ENS', looksLikeEns('vitalik.eth') === true);
check('a raw address does NOT look like ENS', looksLikeEns(A) === false);
check('a plain name does NOT look like ENS', looksLikeEns('Acme') === false);

// ── ENS forward resolution via mock provider ──────────────────────────────────
const mockProvider = {
  async resolveName(name) { return name === 'acme.eth' ? B : null; },
  async lookupAddress(addr) { return ethers.getAddress(addr) === ethers.getAddress(B) ? 'acme.eth' : null; },
};

check('resolveRecipientAsync: ENS name → resolved address, source=ens', await (async () => {
  const r = await resolveRecipientAsync('acme.eth', { book, provider: mockProvider });
  return r.address === ethers.getAddress(B) && r.source === 'ens' && r.name === 'acme.eth';
})());

check('resolveRecipientAsync: unresolvable ENS → throws', await (async () => {
  try { await resolveRecipientAsync('ghost.eth', { book, provider: mockProvider }); return false; }
  catch (e) { return /does not resolve/i.test(e.message); }
})());

check('resolveRecipientAsync: ENS name with no provider → throws', await (async () => {
  try { await resolveRecipientAsync('acme.eth', { book, provider: null }); return false; }
  catch (e) { return /no ENS provider/i.test(e.message); }
})());

check('resolveRecipientAsync: falls back to book for a plain name', await (async () => {
  const r = await resolveRecipientAsync('Treasury cold', { book, provider: mockProvider });
  return r.address === A && r.source === 'name';
})());

// ── reverse ENS is best-effort (never throws) ─────────────────────────────────
check('reverseEns: known address → name', await reverseEns(B, mockProvider) === 'acme.eth');
check('reverseEns: no provider → null (no throw)', await reverseEns(B, null) === null);
check('reverseEns: bad address → null (no throw)', await reverseEns('not-an-address', mockProvider) === null);
check('reverseEns: swallows provider errors → null', await (async () => {
  const boom = { async lookupAddress() { throw new Error('rpc down'); } };
  return (await reverseEns(A, boom)) === null;
})());

// ── listContacts numbers from 1 and checksums ─────────────────────────────────
check('listContacts numbers from 1 + checksums', (() => {
  const list = listContacts(book);
  return list[0].number === 1 && list[0].address === ethers.getAddress(A) && list.length === 3;
})());

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
