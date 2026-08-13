# SAGE — Launch Film Script

**Title:** *"A New Wallet for a New Era"*
**Format:** 75–90s hero film (cutdowns: 30s, 15s, 6s bumper)
**Tone:** Frustration → stillness → awe. Nolan-quiet, not crypto-hype.
**Tagline:** **SAGE — Safe. Agentic. Alive.**

---

## The arc

A man drowning in the *mechanics* of self-custody — keys, seed phrases, EIP
signature popups, gas, wrong addresses — until everything goes quiet and a
different kind of wallet answers back. One he can simply *talk to*.

---

## ACT I — "The Struggle" (0:00–0:35)

Handheld, cool blue light, a cramped desk at night. Fast, anxious cuts. Diegetic
sound only — clicks, error pings, a ticking clock. No music yet.

| Time | Visual | Sound / On-screen |
|------|--------|-------------------|
| 0:00 | Close on a tired face lit by a monitor. A browser extension popup: **"Sign Message"** — a wall of hex `0x19457a…`. He hesitates, squints. | *click… click…* |
| 0:05 | He fumbles a **steel seed-phrase plate** and a scrap of paper: *"word 7? … 'ridge' or 'bridge'?"* Drawer full of hardware wallets. | pen scratching |
| 0:10 | Screen: **`Error: EIP-712 signature invalid (v=27/28)`**. He mouths *"what does that even mean?"* | harsh error *ping* |
| 0:16 | A gas panel spikes red: **"Transaction underpriced."** He bumps gas; next frame: **"Transaction failed — out of gas."** Money gone, nothing sent. | two dull *thuds* |
| 0:22 | He pastes an address. A tiny sweat-beat — *did the clipboard swap it?* He compares character-by-character: `0x7a…9f` vs `0x7a…9f`. | clock ticking louder |
| 0:28 | Phone buzzes — a co-signer: *"can you sign? I'm out, need the other approval."* He's alone with three hardware keys and no way to coordinate. | buzz, sigh |
| 0:33 | He sits back. Hands over face. The monitor glow flattens. Everything stops. | **silence** |

**Cut to black. Two full seconds of nothing.**

---

## ACT II — "The Question" (0:35–0:55)

From black. A single warm point of light breathes in the dark. Low ambient
swell begins. **Calm, unhurried, BBC-documentary voice (VO):**

> *"For twenty years, we've been told this was the price of owning your money."*
>
> *(beat)*
>
> *"The keys. The phrases. The fear of one wrong character."*
>
> *(the light grows, warm)*
>
> **"…but what if your wallet was alive?"**
>
> *"What if you could simply… talk to it —"*
>
> *"— and it talked back?"*
>
> *"In a way that's safe. Multisig. Yours."*

On-screen, softly, as if typed by a calm hand:

```
you    →  "send 500 USDC to Acme, and 200 to vitalik.eth"
sage   →  "proposed both. i've added the first signature.
          review them and tell me when you're ready."
you    →  "signer, approve all i've checked"
sage   →  "done. two signatures, executed. here are the receipts."
```

No hex. No gas panel. No seed phrase. Just a conversation.

---

## ACT III — "The Reveal" (0:55–1:20)

Music resolves into a clean, hopeful theme. Black turns to soft light. The logo
forms. VO, warm and proud:

> *"CRIPTOGRAFIA is proud to present…"*
>
> **"SAGE. The Safe Agentic Wallet."**
>
> *"A team of agents that guard your funds like a treasury — one proposes, one
> signs, and nothing moves without your word."*
>
> *"Built on Safe. Multisig by design. No single key. No one acts alone —
> not even the wallet."*
>
> *"Speak its name. Speak to your money."*
>
> **"A new wallet, for a new era."**

Final frame — logo, tagline, one line of legal calm:

```
              S A G E
        Safe · Agentic · Alive

   Your agents. Your keys. Your rules.
        Built on Safe{Core}.
```

---

## The problems we put on screen (and how SAGE answers them)

Each pain in Act I maps to a concrete SAGE capability — keep them honest, they're
the proof behind the poetry:

| The old pain (Act I) | What SAGE does |
|----------------------|----------------|
| Cryptic **"Sign Message"** hex popups | You approve **plain-language intents** ("send 500 to Acme"), reviewed as names, not hex |
| **Seed phrases / hardware key juggling** | Agent keys are managed + encrypted; the human authorizes by **authenticated identity (email/Privy)**, not by wrangling keys |
| **`EIP-712 signature invalid`** errors | SAGE produces the **canonical Safe EIP-712 signature** every time, and refuses to sign a tx whose hash doesn't match |
| **Gas: underpriced / out of gas** | The signing agent handles execution; you never hand-tune a gas panel |
| **Wrong / clipboard-swapped address** | **Address book + ENS**: you send to *names*; ambiguous or unresolvable references **abort**, never guess |
| **"Can you co-sign? I'm out."** | A **team**: proposal agent + signing agent reach the 2-of-3 threshold on **your instruction** — coordination built in |
| Fear of the wallet acting on its own | **Fail-closed & multisig**: no single key, agents can't reach threshold alone, every action **audited to the operator** |

---

## Production notes

- **VO casting:** measured, resonant, documentary (think natural-history
  narration). Never salesy. The calm *is* the pitch.
- **Sound design:** Act I is all diegetic anxiety (clicks, error pings, ticking).
  The 2s of black silence is the hinge — don't rush it. Music only enters at "what
  if your wallet was alive?"
- **Type on screen:** the chat exchange should type in like a real conversation,
  monospace, generous space. Let viewers *read* that there's no hex, no gas.
- **Do not show** fake balances or promise auto-trading. SAGE is **fail-closed**:
  it proposes and co-signs on your word. Keep the claims exactly true — this film
  doubles as material a serious partner (e.g. Safe) will scrutinize.
- **Optional 6s bumper:** black → warm light → chat line *"signer, approve all i've
  checked" / "done."* → logo + tagline.

---

## Cutdowns

- **30s:** one Act I pain (hex signature + wrong address) → "what if your wallet
  was alive?" → chat exchange → logo.
- **15s:** hex popup frustration → calm VO question → SAGE reveal + tagline.
- **6s:** the chat line and the logo. Nothing else.

---

## One-liners (thumbnails, ads, hero copy)

- *"What if your wallet was alive?"*
- *"Stop signing hex. Start talking."*
- *"Your agents. Your keys. Your rules."*
- *"A treasury team in your wallet — one proposes, one signs, nothing moves without your word."*
- *"Multisig you can talk to."*
