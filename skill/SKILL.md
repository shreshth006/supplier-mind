# Anjoman skill for a Mind: buy specialist checks through Telegraph

One HTTP integration gives a Mind every Telegraph intent. Add an HTTP tool in Minds, store
the Anjoman API key in the Mind's **private credentials** (never in the skill text), and send
it as `Authorization: Bearer <key>`.

Base URL: `https://backend.telegraphprotocol.com`. An OpenAPI description of the three calls
is in `openapi.json` next to this file.

## The calls

### 1. `POST /engine/ask` — one named check (use this for every routine check)

```json
{ "intent": "SANCTIONS_SCREENING_MATCH_GENERAL", "params": { "name": "Siemens AG" } }
```

The reply is `{ result, receipt }`. Keep from it, for every answer you rely on:
`result.miner_name`, `result.result` (the answer), `result.cost_usd_total`,
`result.signal_hash` and `receipt.receipt_hash`. These are what lets a reviewer, or anyone
later, audit the decision.

`POST /engine/ask/{minerId}` with the same body asks one named Provider, for a second
opinion from someone other than the Provider that answered first.

### 2. `POST /agent/chat` — an open question the agent plans and buys

```json
{ "message": "…", "stream": false, "maxSpendUsd": 0.25 }
```

Minds' HTTP tool gives up after 60 seconds, but a job keeps running on the server. If the
reply is HTTP 202 or `status: "running"`, keep its `jobId` and call
`GET /agent/jobs/{jobId}` every 5 seconds until `status` is no longer `running` (give up
after 5 minutes). `GET /agent/spend` lists recent jobs if the id was lost.

A `maxSpendUsd` that is too low makes the job stop with `status: "waiting_authorization"`,
`reason: "spend_limit_reached"` and nothing charged; $0.05 was too low for a URL scan
planned by the agent, so name the intent with `/engine/ask` when you know it.

### 3. `GET /engine/escrow/balance`

`effectiveBalance` is what can be spent now, in test USDC. A call is refused unless about
**$0.26** is available, so top up before the balance falls to a quarter-dollar.

## Rules that matter in practice

- **One paid ask at a time.** Asks fired at the same moment from one account were rejected
  ("Payment was rejected by the facilitator"); the same asks in turn all passed. Retry a
  rejected payment once after a few seconds — a rejected payment is not charged.
- **An answer that did not come back is never a pass.** Empty results, errors and refused
  payments are "unanswered", and an unanswered check means the decision is REVIEW at best.
- **Read the answer's shape, not only one field.** URL scanners answer `{ "safe": true }`,
  `{ "risk": 0.9 }` or a sentence; read all three.
- **Providers can be wrong.** On 2026-11-20 one URL scanner called Google Safe Browsing's
  public phishing test page safe while another called it unsafe. Ask a second Provider for
  anything that would release money, and keep the worse verdict.

## Intents for paying a supplier

| Check | Intent | Params | Answer |
|---|---|---|---|
| Registry | `CORPORATE_REGISTRY_LOOKUP_GENERAL` | `company`, `jurisdiction` | `legal_name`, `registration_id`, `active` |
| Sanctions | `SANCTIONS_SCREENING_MATCH_GENERAL` | `name` | `matched`, `matches`, `lists` |
| Payment link | `URL_SCAN_VERDICT` | `url` | `safe` (or `risk`, or a sentence) |
| Invoice FX | `CURRENCY_EXCHANGE_CONVERT` | `from_currency`, `to_currency`, `amount` | `converted_amount` |
| Adverse media | `WEB_SEARCH_GENERAL` | `query` | `answer`, `sources` |
| VAT number | `VENDOR_VERIFY_GENERAL` | `vendor`, `vat_number` | `valid`, `registered_name` |

Each was about $0.01–0.02 per ask on Sepolia testnet in November 2026.
