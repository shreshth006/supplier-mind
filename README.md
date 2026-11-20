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
| Siemens AG, swapped payment link (phishing test page) | HOLD | REVIEW (read "phishing" in the URL) | REVIEW, not HOLD: escrow ran out before the second scanner | $0.05 |
| Siemens AG, invoice FX inverted | HOLD | RELEASE ✗ | not run: escrow ran out | – |

Without Telegraph: **2 of 6**, and two invoices it would have paid (a lapsed LEI, an
invoice 21.6% short). With Telegraph: **4 of 4 completed cases**, and the two unfinished
cases never reached RELEASE. The last two are rerun with the next faucet claim.

### What the Reviewer caught

- **A Provider that was wrong.** Counterproof URL Safety called Google Safe Browsing's public
  phishing test page *safe*, so the Investigator released the swapped-link invoice. The
  Reviewer moved it to REVIEW because the link is on `appspot.com`, not a Siemens domain, and
  asked ChainSight directly, which calls the same page unsafe (risk 0.9).
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
