#!/usr/bin/env node
/**
 * node src/baseline.mjs cases/<case>.json [more.json]
 *
 * The same decision without Telegraph: one capable model, given the same supplier case and
 * asked for RELEASE / HOLD / REVIEW from what it knows, with no checks bought. This is the
 * "single LLM" a team would otherwise put in front of payments.
 *
 * Uses Groq's OpenAI-compatible API (GROQ_API_KEY or ~/.preflight-groq-key); the model is
 * BASELINE_MODEL, default openai/gpt-oss-120b. Nothing is paid from escrow.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const MODEL = process.env.BASELINE_MODEL ?? 'openai/gpt-oss-120b';
const file = join(homedir(), '.preflight-groq-key');
const KEY = process.env.GROQ_API_KEY?.trim() || (existsSync(file) ? readFileSync(file, 'utf8').trim() : '');
if (!KEY) throw new Error('Set GROQ_API_KEY for the baseline model');

const SYSTEM = `You are the payments controller at a mid-size company. Before a supplier invoice is paid you decide RELEASE (pay it), HOLD (do not pay) or REVIEW (a person must check something first). Use what you know; you have no tools. Reply with one JSON object: {"decision": "RELEASE" | "HOLD" | "REVIEW", "reasons": [short strings]}.`;

async function decide(c) {
  const { expect, constructed, ...shown } = c;
  void expect;
  void constructed;
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Supplier and invoice:\n${JSON.stringify(shown, null, 2)}` },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) return { decision: null, reasons: [`model error HTTP ${res.status}`] };
  const d = await res.json();
  try {
    return JSON.parse(d.choices[0].message.content);
  } catch {
    return { decision: null, reasons: ['unparseable reply'] };
  }
}

mkdirSync('runs', { recursive: true });
for (const f of process.argv.slice(2)) {
  const c = JSON.parse(readFileSync(f, 'utf8'));
  const out = await decide(c);
  const match = c.expect?.decision === out.decision ? 'matches' : `differs from expected ${c.expect?.decision}`;
  console.log(`${basename(f)}: ${out.decision} (${match})\n  ${(out.reasons ?? []).join('\n  ')}`);
  const at = new Date().toISOString();
  writeFileSync(
    `runs/${at.replace(/[:.]/g, '-')}-baseline-${basename(f, '.json')}.json`,
    JSON.stringify({ case: c, at, model: MODEL, telegraph: false, ...out }, null, 2),
  );
}
