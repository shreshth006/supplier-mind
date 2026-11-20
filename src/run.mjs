#!/usr/bin/env node
/**
 * node src/run.mjs cases/<case>.json [more.json] [--no-review]
 *
 * Runs the Investigator, then the Reviewer, on each supplier case and writes the full
 * record (every finding with its Provider, price, signal hash and escrow receipt) to
 * runs/<time>-<case>.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { balance } from './anjoman.mjs';
import { investigate } from './investigate.mjs';
import { review } from './review.mjs';

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.log('usage: node src/run.mjs cases/<case>.json [more.json] [--no-review]');
  process.exit(1);
}
mkdirSync('runs', { recursive: true });
const mark = { pass: 'ok  ', fail: 'FAIL', review: 'look', unanswered: '??  ' };
const line = (f) =>
  `  [${mark[f.status]}] ${f.check}${f.purchase?.miner_name ? ` · ${f.purchase.miner_name} · $${f.purchase.cost_usd ?? '?'} · ${f.purchase.receipt?.receipt_hash?.slice(0, 12) ?? 'no receipt'}` : f.source ? ` · ${f.source}` : ''}\n         ${f.summary}`;

const before = await balance();
for (const file of files) {
  const c = JSON.parse(readFileSync(file, 'utf8'));
  const t0 = Date.now();
  const memo = await investigate(c);
  console.log(`\n${c.name}  (${basename(file)})\nInvestigator: ${memo.decision}`);
  memo.findings.forEach((f) => console.log(line(f)));
  const rev = args.includes('--no-review') ? null : await review(memo, c);
  if (rev) {
    console.log(`Reviewer: ${rev.decision}${rev.changed ? ` (moved down from ${rev.from})` : ' (agrees)'}`);
    rev.changes.forEach((ch) => console.log(`  [down] ${ch.check}: ${ch.why}`));
    rev.extra_findings.forEach((f) => console.log(line(f)));
  }
  const final = rev?.decision ?? memo.decision;
  const cost = Math.round((memo.cost_usd + (rev?.cost_usd ?? 0)) * 100) / 100;
  const match = c.expect ? (c.expect.decision === final ? 'matches' : `differs from expected ${c.expect.decision}`) : '';
  console.log(`FINAL: ${final} · $${cost} · ${((Date.now() - t0) / 1000).toFixed(1)} s ${match}`);
  const at = new Date().toISOString();
  const out = `runs/${at.replace(/[:.]/g, '-')}-${basename(file, '.json')}.json`;
  writeFileSync(out, JSON.stringify({ case: c, at, final, cost_usd: cost, investigator: memo, reviewer: rev }, null, 2));
  console.log(`wrote ${out}`);
}
const after = await balance();
console.log(`\nescrow: ${before?.effectiveBalance} -> ${after?.effectiveBalance} USDC (charges can settle a little later)`);
