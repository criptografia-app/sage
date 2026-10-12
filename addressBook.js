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
 * SAGE — Address Book
 *
 * A named registry of recipients so the proposal agent can resolve a human
 * reference ("send to #5", "Acme cold wallet") into a checksummed address.
 * Approving NAMES instead of 40 hex chars is a safety win as much as a UX one —
 * an operator can actually eyeball "Acme cold wallet" on the review page.
 *
 * Backed by address-book.json next to this module. Pure + offline-testable:
 * every function takes the book as an argument (default: the on-disk file).
 */
import { ethers } from 'ethers';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const BOOK_PATH = join(__dir, 'address-book.json');

/** Load the address book, or an empty one if the file is absent/unreadable. */
export function loadAddressBook(path = BOOK_PATH) {
  try {
    if (!existsSync(path)) return { contacts: [] };
    const book = JSON.parse(readFileSync(path, 'utf8'));
    return { contacts: Array.isArray(book.contacts) ? book.contacts : [] };
  } catch {
    return { contacts: [] };
  }
}

/** List contacts with a stable 1-based index — the "open address book" popup. */
export function listContacts(book = loadAddressBook()) {
  return book.contacts.map((c, i) => ({
    number:  i + 1,
    name:    c.name,
    address: ethers.isAddress(c.address) ? ethers.getAddress(c.address) : c.address,
    note:    c.note ?? null,
  }));
}

/**
 * Resolve a recipient reference to a checksummed address.
 * Accepts, in order: a literal 0x address, a 1-based book number, an exact
 * (case-insensitive) name, or an unambiguous name prefix.
 *
 * @param {string|number} ref
 * @param {{contacts:Array}} [book]
 * @returns {{ address: string, name: string|null, source: 'literal'|'index'|'name' }}
 * @throws if the reference matches nothing, or matches more than one contact.
 */
export function resolveRecipient(ref, book = loadAddressBook()) {
  if (ref === null || ref === undefined || ref === '') {
    throw new Error('address book: empty recipient reference');
  }

  // 1. A literal address wins outright.
  if (typeof ref === 'string' && ethers.isAddress(ref)) {
    return { address: ethers.getAddress(ref), name: null, source: 'literal' };
  }

  const contacts = book.contacts || [];

  // 2. A 1-based index into the book.
  const asNum = Number(ref);
  if (Number.isInteger(asNum) && String(ref).trim() !== '' && asNum >= 1 && asNum <= contacts.length) {
    const c = contacts[asNum - 1];
    return { address: ethers.getAddress(c.address), name: c.name, source: 'index' };
  }

  // 3. By name: exact (case-insensitive) first, else a unique prefix.
  const q = String(ref).trim().toLowerCase();
  const exact = contacts.filter(c => c.name.toLowerCase() === q);
  const matches = exact.length === 1 ? exact : contacts.filter(c => c.name.toLowerCase().startsWith(q));

  if (matches.length === 1) {
    return { address: ethers.getAddress(matches[0].address), name: matches[0].name, source: 'name' };
  }
  if (matches.length === 0) {
    throw new Error(`address book: no contact matching "${ref}"`);
  }
  throw new Error(`address book: "${ref}" is ambiguous — matches ${matches.map(c => c.name).join(', ')}`);
}

// ── ENS ──────────────────────────────────────────────────────────────────────
// ENS names are the universal recipient naming norm, so SAGE resolves them both
// ways. Forward resolution is used when proposing (you can just say the name);
// reverse resolution decorates addresses for the review page. ENS lives on
// Ethereum mainnet regardless of the Safe's chain, so these take a mainnet
// provider — kept OUT of the sync resolver above so that stays pure + offline.

/** True if `ref` is not an address but looks like an ENS name (has a TLD-ish suffix). */
export function looksLikeEns(ref) {
  return typeof ref === 'string' && !ethers.isAddress(ref) && /\.[a-z0-9-]+$/i.test(ref.trim());
}

/**
 * Resolve a recipient reference to an address, ENS included.
 * Order: literal address → ENS name (via provider) → book index/name.
 *
 * @param {string|number} ref
 * @param {{ book?: object, provider?: import('ethers').Provider }} [opts]
 * @returns {Promise<{ address: string, name: string|null, source: string }>}
 */
export async function resolveRecipientAsync(ref, { book = loadAddressBook(), provider = null } = {}) {
  if (typeof ref === 'string' && ethers.isAddress(ref)) {
    return { address: ethers.getAddress(ref), name: null, source: 'literal' };
  }
  if (looksLikeEns(ref)) {
    if (!provider) {
      throw new Error(`"${ref}" looks like an ENS name but no ENS provider is configured (set ENS_RPC / ETH_RPC)`);
    }
    const address = await provider.resolveName(String(ref).trim());
    if (!address) throw new Error(`ENS: "${ref}" does not resolve to an address`);
    return { address: ethers.getAddress(address), name: String(ref).trim(), source: 'ens' };
  }
  return resolveRecipient(ref, book);
}

/**
 * Best-effort reverse ENS: address → primary name, or null. Never throws — a
 * missing name or a flaky RPC must not break a listing or a review page.
 *
 * @param {string} address
 * @param {import('ethers').Provider} provider
 * @returns {Promise<string|null>}
 */
export async function reverseEns(address, provider) {
  if (!provider || !ethers.isAddress(address)) return null;
  try {
    return await provider.lookupAddress(ethers.getAddress(address));
  } catch {
    return null;
  }
}
