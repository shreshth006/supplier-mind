/**
 * The Anjoman API, which is the whole integration with Telegraph: one key, three calls.
 *
 *   ask(intent, params)  POST /engine/ask        one specialist answer, with its receipt
 *   chat(message)        POST /agent/chat        a free-text question the agent plans and buys
 *   balance()            GET  /engine/escrow/balance
 *
 * The key comes from ANJOMAN_API_KEY or ~/.anjoman/key and is only ever sent in the
 * Authorization header.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.ANJOMAN_BASE ?? 'https://backend.telegraphprotocol.com';

function key() {
  const env = process.env.ANJOMAN_API_KEY?.trim();
  if (env) return env;
  const file = join(homedir(), '.anjoman', 'key');
  const k = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  if (!k) throw new Error('Set ANJOMAN_API_KEY (an Anjoman API key) or write it to ~/.anjoman/key');
  return k;
}

async function call(method, path, body, ms = 120_000) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${key()}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(ms),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* a gateway error page */
  }
  return { status: res.status, json, text: json ? '' : text.slice(0, 300) };
}

/**
 * One specialist answer for an intent. Returns what an auditor needs to check it later:
 * the Provider, the answer, the price, the signal hash and the escrow receipt.
 */
export async function ask(intent, params, opts = {}) {
  const first = await askOnce(intent, params, opts);
  // A payment the facilitator rejects was not charged; one retry a moment later clears it.
  if (!first.ok && /payment was rejected/i.test(first.error ?? '')) {
    await new Promise((r) => setTimeout(r, 3_000));
    return { ...(await askOnce(intent, params, opts)), retried: first.error };
  }
  return first;
}

async function askOnce(intent, params, { minerId } = {}) {
  const started = Date.now();
  try {
    const { status, json, text } = await call(
      'POST',
      minerId ? `/engine/ask/${minerId}` : '/engine/ask',
      { intent, params },
    );
    const r = json?.result ?? {};
    const receipt = json?.receipt ?? r.payments?.[0] ?? null;
    return {
      intent,
      params,
      ok: status === 200 && !!r.result,
      http_status: status,
      miner_id: r.miner_id ?? null,
      miner_name: r.miner_name ?? null,
      result: r.result ?? null,
      field_status: r.field_status ?? null,
      warnings: r.warnings ?? null,
      cost_usd: r.cost_usd_total ?? r.cost_usd ?? null,
      signal_hash: r.signal_hash ?? null,
      receipt: receipt
        ? {
            receipt_hash: receipt.receipt_hash,
            rail: receipt.rail ?? 'escrow',
            amount_uusdc: receipt.amount_uusdc,
            miner: receipt.miner,
            epoch_id: receipt.epoch_id,
          }
        : null,
      duration_ms: Date.now() - started,
      error: status === 200 ? null : (json?.message ?? json?.error ?? text ?? `HTTP ${status}`),
    };
  } catch (e) {
    return { intent, params, ok: false, error: String(e?.message ?? e), duration_ms: Date.now() - started };
  }
}

/**
 * A free-text question. The agent picks the intents and Providers and buys them within
 * maxSpendUsd. A reply still running after about 80 s comes back as 202 with a jobId; the
 * job keeps running, so it is polled until it finishes (Minds' own HTTP tool cuts off at
 * 60 s, which is why a Mind needs the same polling).
 */
export async function chat(message, { maxSpendUsd = 0.25, pollMs = 5_000, timeoutMs = 300_000 } = {}) {
  const started = Date.now();
  const first = await call('POST', '/agent/chat', { message, stream: false, maxSpendUsd }, 100_000);
  let job = first.json;
  const id = job?.jobId;
  while (id && job?.status === 'running' && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    job = (await call('GET', `/agent/jobs/${id}`, undefined, 30_000)).json ?? job;
  }
  return {
    message,
    job_id: id ?? null,
    status: job?.status ?? `http_${first.status}`,
    outcome: job?.outcome ?? null,
    reason: job?.reason ?? null,
    answer: job?.answer ?? null,
    sources: job?.sources ?? [],
    cost_usd: job?.costUsd ?? null,
    duration_ms: Date.now() - started,
  };
}

export async function balance() {
  return (await call('GET', '/engine/escrow/balance', undefined, 20_000)).json;
}
