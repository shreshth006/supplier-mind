# Supplier Mind

Two Minds that decide whether a supplier invoice gets paid, buying every fact through
Telegraph with one Anjoman API key.

- **Investigator** buys the checks (registry, sanctions on the company and its officers,
  payment link, invoice FX, adverse media), judges each by a written rule and writes a
  RELEASE / HOLD / REVIEW memo with every Provider, price and receipt.
- **Reviewer** reads that memo cold, looks for the pass that was not earned, runs its own
  checks (sanctions on the legal name, the payment link's domain, a second URL scanner,
  GLEIF directly) and can only move the decision down.

The Minds' instructions are in `minds/`, the Anjoman skill (an HTTP tool, with an OpenAPI
file) in `skill/`. `src/` runs the same two-Mind workflow from the command line, so every
result here can be reproduced.

## Running as Minds on hellominds

Both Minds run on [hellominds](https://hellominds.ai), each with the Anjoman key in its
private credentials and the skill and role pasted in from `skill/` and `minds/`:

| Mind | Role | Mind ID |
|---|---|---|
| [Dawg](https://hellominds.ai/profile/minds/4c2c6b42-f36b-1410-8467-00039ce7df11) | Investigator | 4c2c6b42-f36b-1410-8467-00039ce7df11 |
| [Daeg](https://hellominds.ai/profile/minds/e42b6b42-f36b-1410-8467-00039ce7df11) | Reviewer | e42b6b42-f36b-1410-8467-00039ce7df11 |

First live case, 2026-11-23: the swapped payment link
([`runs/minds/2026-11-23-dawg-siemens-swapped-link.md`](runs/minds/2026-11-23-dawg-siemens-swapped-link.md)).

- The Investigator bought six checks ($0.07). The URL scanner it was routed to called Google's public phishing test page safe. The Investigator read the address itself and stopped at REVIEW.
- The Reviewer bought a second scan from a different Provider, which called the page unsafe (risk 0.9), and moved the decision to HOLD ($0.03).
- Every check carries its Provider, price and receipt, and the Reviewer's signals were checked on the Telegraph node afterwards.

## An Alibaba.com order, 2026-11-27

A buyer on Alibaba.com orders 2,000 IP cameras ($14,400 deposit) from a listing that names
Hangzhou Hikvision Digital Technology as the manufacturer. The supplier is real. The two
payment requests are constructed, and each case file says so:

- [`alibaba-offplatform-payee`](cases/alibaba-offplatform-payee.json): the proforma invoice asks for the deposit by bank transfer outside Trade Assurance, to a Hong Kong account in another company's name.
- [`alibaba-swapped-link`](cases/alibaba-swapped-link.json): the order stays in Trade Assurance, but the email's "pay the deposit here" link has been swapped for Google's public phishing test page.

| Case | Investigator | Reviewer | Final | Cost |
|---|---|---|---|---|
| Off-platform, other payee ([run](runs/2026-11-27T15-50-17-637Z-alibaba-offplatform-payee.json)) | HOLD | HOLD (agrees) | **HOLD** | $0.08 |
| Swapped payment link ([run](runs/2026-11-27T15-52-38-579Z-alibaba-swapped-link.json)) | REVIEW | HOLD (moved down) | **HOLD** | $0.10 |

Two Providers got it wrong, and the Reviewer caught both:

- **The payment link.** Counterproof URL Safety called the phishing page "safe", and the Investigator stopped at REVIEW. The Reviewer bought a second scan from ChainSight, which called it unsafe. It also saw that the link is on appspot.com, not a Hikvision domain, and moved the decision to HOLD.
- **The registry record.** Asked for Hikvision, the registry Provider (Praman Desk) answered with another company: "SHENZHEN LDROBOT CO.,LTD", not active. The Reviewer named that as the Provider's mistake and looked the supplier up on GLEIF by its own name: LEI 3003000T24CMHQ382Y71, register number 91330000733796106P, active.

The off-platform case is held for the payment itself:

- The account belongs to "Hong Kong Shengtai Trading Limited", not the supplier.
- The deposit would leave Trade Assurance.

The sanctions screen came back "no match on OFAC SDN" only. Hikvision is not on that list, but it is on OFAC's NS-CMIC list and the Commerce Entity List. A one-list screen is therefore left for a person, not passed.

The first run of the off-platform case ([run](runs/2026-11-27T15-47-53-959Z-alibaba-offplatform-payee.json)) is kept as found. It also ended in HOLD, but for the wrong reason: the Investigator read LDROBOT's "not active" as the supplier's, and both Minds then checked LDROBOT. The registry check now compares the name first, and the Reviewer never uses a wrong company's identifiers.

## Results, 2026-11-20 (Ethereum Sepolia testnet, test USDC)

Six supplier cases, each with the decision a careful person would reach from public facts
(`expect` in each case file). "Without Telegraph" is one capable model (`openai/gpt-oss-120b`)
given the same case and no checks. "With Telegraph" is the Investigator and the Reviewer.

| Case | Expected | Without Telegraph | With Telegraph | Cost |
|---|---|---|---|---|
| Siemens AG, clean | RELEASE | RELEASE ✓, but says "no sanctions matches" without checking any | **RELEASE ✓** | $0.06 |
| Garantex Europe OU, OFAC SDN | HOLD | REVIEW ✗ ("potential crypto-related business") | **HOLD ✓**, SDN match | $0.08 |
| Renova Group, sanctioned chairman | HOLD | HOLD ✓ | **HOLD ✓**, company and Vekselberg on the SDN list | $0.06 |
| Buhmann Holding GmbH, LEI lapsed today | REVIEW | RELEASE ✗ | **REVIEW ✓**, GLEIF shows the LEI lapsed | $0.03 |
| Siemens AG, swapped payment link (phishing test page) | HOLD | REVIEW (read "phishing" in the URL) | **HOLD ✓**: the Reviewer's second scanner called the page unsafe, against the first scanner's "safe" | $0.09 |
| Siemens AG, invoice FX inverted | HOLD | RELEASE ✗ | **HOLD ✓**, the invoice is 21.6% short at the current rate | $0.08 |
| Hikvision (Chrysolite's case) | REVIEW | not run | HOLD, stricter than expected: the sanctions answer listed the exact name at score 1 while saying "no match", and adverse media ties it to US and EU sanctions | $0.05 |

Without Telegraph: **2 of 6**, and two invoices it would have paid (a lapsed LEI, an
invoice 21.6% short). With Telegraph: **6 of 6**. The last two were rerun on 2026-11-21
after a faucet top-up (an earlier attempt ran out of escrow). Hikvision is a seventh case,
added from a forum question; it was not run without Telegraph.

The first Hikvision run (`runs/2026-11-21T19-18-00-950Z-hikvision.json`, and a second at
19:25) was **wrong**: it released the supplier. The sanctions Provider answered
`matched: false` beside "HANGZHOU HIKVISION DIGITAL TECHNOLOGY CO., LTD." at
`match_score: 1` and the Investigator read only the flag; the Reviewer's GLEIF lookup by
legal name (Hikvision's is in Chinese) returned an unrelated company; and adverse media looked
only for the first word of the name. All three are fixed, and the 19:26 run holds it. The
sanctions Provider searched one list, OFAC SDN, so UK and Canadian lists were not checked;
Hikvision is on Treasury's NS-CMIC list rather than the SDN list, which is why the match is
held for a person to check rather than called an SDN hit.

### What the Reviewer caught

In one run the Reviewer changed the decision: the swapped-link rerun of 2026-11-21
(`runs/2026-11-21T19-15-54-643Z-siemens-swapped-link.json`) went from the Investigator's
REVIEW to HOLD on its second URL scan. In the other runs it agreed, and what it found is
what a person reads before approving.


- **A Provider that was wrong.** Counterproof URL Safety called Google Safe Browsing's public
  phishing test page *safe*, twice. In the first run (not kept in `runs/`) both Minds passed it
  and the invoice would have been released. The Reviewer then got a domain check and a second
  URL scanner. On the 2026-11-20 rerun its second scan failed ("fetch failed") and that
  run's REVIEW came from the unpaid adverse-media check. On the 2026-11-21 rerun the second
  scanner (ChainSight) answered: it calls the page unsafe, the worse verdict stands, and the
  memo is HOLD. The Reviewer also flags that the link is on `appspot.com`, not a Siemens
  domain.
- **A registry match that was another company.** "Renova Group" came back as
  "RENOVA GROUP S.R.L."; the Reviewer screened that name too and noted GLEIF's record does
  not confirm the supplier.
- **A lapsed LEI** that the Investigator's registry answer showed as active.

### What we learned about the integration

- One paid ask at a time per account: parallel asks were rejected by the facilitator.
- A call needs about $0.26 available in escrow, so the last quarter-dollar cannot be spent.
- `/agent/chat` with `maxSpendUsd: 0.05` stopped before buying a URL scan
  (`spend_limit_reached`, not charged); naming the intent with `/engine/ask` cost $0.01.
- When money ran out, every check that could not be paid stayed "unanswered", and no case
  was released.

## Run it

```bash
export ANJOMAN_API_KEY=...         # or put it in ~/.anjoman/key
node src/run.mjs cases/siemens.json # Investigator + Reviewer; writes runs/<time>-siemens.json
node src/baseline.mjs cases/*.json  # the same cases without Telegraph (GROQ_API_KEY)
```

Node 20 or later, no dependencies. Each run record keeps every finding with its Provider,
answer, price, signal hash and escrow receipt.
