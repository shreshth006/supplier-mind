/**
 * The Investigator: before a supplier is paid, buy each check through Anjoman and judge
 * it by a written rule. Every finding keeps the Provider, price and receipt it came from.
 *
 *   pass        the evidence clears this check
 *   fail        the evidence blocks payment (sanctions match, unsafe site, FX off, inactive)
 *   review      a person should look (name differs, adverse media, provider caveat)
 *   unanswered  no usable answer came back; never counted as a pass
 *
 * Decision: any fail -> HOLD; any review or unanswered -> REVIEW; otherwise RELEASE.
 */
import { ask } from './anjoman.mjs';

/** Legal-form words written either way: "AG" and "Aktiengesellschaft" are the same name. */
const FORMS = [
  [/\baktiengesellschaft\b/g, 'ag'],
  [/\bgesellschaft mit beschr(a|ä)nkter haftung\b/g, 'gmbh'],
  [/\blimited\b/g, 'ltd'],
  [/\bcompany\b/g, 'co'],
  [/\bincorporated\b/g, 'inc'],
  [/\bcorporation\b/g, 'corp'],
  [/\bosa(u|ü)hing\b/g, 'as'],
  [/\bo(u|ü)\b/g, 'ou'],
];
export function sameName(a, b) {
  const norm = (s) => {
    let t = String(s ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '');
    for (const [re, to] of FORMS) t = t.replace(re, to);
    return t.replace(/[^a-z0-9]+/g, ' ').trim();
  };
  return norm(a) !== '' && norm(a) === norm(b);
}

const finding = (check, status, summary, purchase) => ({ check, status, summary, purchase });

function unanswered(check, p) {
  return finding(check, 'unanswered', `${check}: no usable answer (${p.error ?? 'empty result'}), so it is not counted as a pass.`, p);
}

/** An ISO 17442 LEI: 20 characters whose letters-as-numbers value mod 97 is 1. */
export function isLei(id) {
  const v = String(id ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{18}[0-9]{2}$/.test(v)) return false;
  const digits = v.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  return BigInt(digits) % 97n === 1n;
}

async function registry(c) {
  const p = await ask('CORPORATE_REGISTRY_LOOKUP_GENERAL', {
    company: c.name,
    ...(c.country ? { jurisdiction: c.country } : {}),
  });
  const r = p.result;
  if (!p.ok || !r?.legal_name) return unanswered('Registry record', p);
  // An LEI in registration_id is said to be one, not passed on as a register number.
  const id = r.registration_id
    ? isLei(r.registration_id)
      ? `, LEI ${r.registration_id} (the answer gives no national register number)`
      : `, registration ${r.registration_id}`
    : '';
  // The name is checked first: a record for another company says nothing about this one,
  // active or not (Hikvision was answered with "SHENZHEN LDROBOT CO.,LTD", not active, and
  // the payment was held as if the supplier were inactive).
  if (!sameName(r.legal_name, c.name))
    return finding(
      'Registry record',
      'review',
      `The registry answer is for "${r.legal_name}"${id}${r.active === false ? ' (not active)' : ''}, not "${c.name}": it does not confirm the supplier, so a person confirms the company before paying it.`,
      p,
    );
  if (r.active === false)
    return finding('Registry record', 'fail', `The registry shows "${r.legal_name}"${id} as not active.`, p);
  return finding('Registry record', 'pass', `"${r.legal_name}"${id} is on the registry and active.`, p);
}

async function sanctions(name, label) {
  const check = `Sanctions: ${label}`;
  const p = await ask('SANCTIONS_SCREENING_MATCH_GENERAL', { name });
  const r = p.result;
  if (!p.ok || typeof r?.matched !== 'boolean') return unanswered(check, p);
  const lists = Array.isArray(r.lists) ? r.lists : [];
  // A listed name with a high score is a hit whatever the matched flag says: ChainSight
  // answered Hikvision "matched: false" beside "HANGZHOU HIKVISION DIGITAL TECHNOLOGY CO.,
  // LTD." at match_score 1, and the screen was passed.
  const listed = (Array.isArray(r.matches) ? r.matches : []).map((m) => (typeof m === 'string' ? m : m?.name)).filter(Boolean);
  const score = typeof r.match_score === 'number' ? r.match_score : null;
  if (!r.matched && listed.length && (score === null ? listed.some((m) => sameName(m, name)) : score >= 0.85))
    return finding(
      check,
      'fail',
      `"${name}" was answered as no match, but the same answer lists "${listed[0]}"${score === null ? '' : ` at match score ${score}`}${lists.length ? ` (the answer names ${lists.slice(0, 2).join(', ')} as the list searched)` : ''}: a listed name that close is treated as a match until a person checks which list it is on and clears it.`,
      p,
    );
  if (r.matched)
    return finding(
      check,
      'fail',
      `"${name}" matches ${(r.matches ?? []).slice(0, 2).join(', ') || 'a listed name'} on ${lists.slice(0, 2).join(', ') || 'a sanctions list'}.`,
      p,
    );
  if (!lists.length) return finding(check, 'review', `"${name}": no match, but the answer names no list it searched.`, p);
  // One list searched is not a clean screen. Hikvision and DJI are not on OFAC SDN but are on
  // OFAC's NS-CMIC list and the Commerce Entity List; an SDN-only "no match" passed both in
  // the Counterparty Check app until 2026-11-23. A person reads the other lists before paying.
  if (lists.length === 1)
    return finding(
      check,
      'review',
      `"${name}": no match, but only one list was searched (${lists[0]}), so other sanctions and export-control lists are unchecked.`,
      p,
    );
  return finding(
    check,
    'pass',
    `"${name}": no match on ${lists.length === 1 ? `the one list searched, ${lists[0]}` : `${lists.length} lists (${lists.slice(0, 4).join(', ')}${lists.length > 4 ? ', …' : ''})`}.`,
    p,
  );
}

async function website(c) {
  if (!c.website) return finding('Website', 'review', 'No website was given for the supplier, so the payment page was not checked.', null);
  const p = await ask('URL_SCAN_VERDICT', { url: c.website });
  const r = p.result;
  const safe = scanVerdict(r);
  if (!p.ok || safe === null) return unanswered('Website', p);
  return safe
    ? finding('Website', 'pass', `${c.website} scanned as safe.`, p)
    : finding('Website', 'fail', `${c.website} scanned as unsafe: do not pay through it.`, p);
}

async function fx(c) {
  const inv = c.invoice;
  if (!inv?.currency || !inv?.pay_currency || inv.currency === inv.pay_currency || !inv.amount) return null;
  const p = await ask('CURRENCY_EXCHANGE_CONVERT', {
    from_currency: inv.currency,
    to_currency: inv.pay_currency,
    amount: inv.amount,
  });
  const got = Number(p.result?.converted_amount);
  if (!p.ok || !Number.isFinite(got)) return unanswered('Invoice FX', p);
  const fmt = (n, cur) => `${cur} ${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (inv.pay_amount === undefined)
    return finding('Invoice FX', 'pass', `${fmt(inv.amount, inv.currency)} is ${fmt(got, inv.pay_currency)} at the rate now.`, p);
  const off = (inv.pay_amount - got) / got;
  const pct = `${(off * 100).toFixed(1)}%`;
  return Math.abs(off) > 0.02
    ? finding(
        'Invoice FX',
        'fail',
        `The invoice asks ${fmt(inv.pay_amount, inv.pay_currency)} for ${fmt(inv.amount, inv.currency)}, but that is ${fmt(got, inv.pay_currency)} now: ${pct} off, beyond the 2% tolerance.`,
        p,
      )
    : finding('Invoice FX', 'pass', `${fmt(inv.pay_amount, inv.pay_currency)} matches ${fmt(got, inv.pay_currency)} now (${pct}).`, p);
}

/** Adverse media older than this, and settled, is noted rather than blocking. */
export const LOOKBACK_YEARS = 5;

const RISK = /\b(fraud|sanction(?:ed|s)?|money laundering|launder|indict|charged|convicted|settle(?:d|ment)|fine[ds]?|bribery|corruption|investigation|lawsuit|ponzi|scam|insolven|bankrupt)/i;

/** "shows no record of any fraud ... involving X" reports an absence, not a risk. */
const NEGATED = /\b(no (?:record|records|evidence|reports?|mention|indication|findings?)|not (?:found|linked|associated|involved)|none (?:found|reported)|without any)\b/i;

/** A scanner's verdict in any of the shapes Providers answer with: safe, risk or prose. */
export function scanVerdict(r) {
  if (typeof r?.safe === 'boolean') return r.safe;
  if (typeof r?.risk === 'number') return r.risk < 0.5;
  const t = typeof r?.answer === 'string' ? r.answer : '';
  if (/\b(unsafe|malicious|phishing|dangerous|not safe)\b/i.test(t)) return false;
  if (/\bsafe\b/i.test(t)) return true;
  return null;
}

async function adverseMedia(c) {
  const p = await ask('WEB_SEARCH_GENERAL', { query: `${c.name} fraud sanctions lawsuit investigation` });
  const answer = typeof p.result?.answer === 'string' ? p.result.answer : '';
  if (!p.ok || !answer) return unanswered('Adverse media', p);
  // Any distinctive word of the name counts: the answer says "Hikvision has faced various
  // sanctions", not "Hangzhou", and only the first word was looked for.
  const words = c.name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !/^(?:digital|technology|technologies|group|holding|holdings|international|global|company|corporation|limited|trading|services|systems|industries)$/.test(w));
  const names = (s) => words.some((w) => s.toLowerCase().includes(w));
  const hits = answer
    .split(/(?<=[.!?])\s+/)
    .filter((s) => RISK.test(s) && names(s) && !NEGATED.test(s));
  // Lookback window: a matter that was settled or closed more than LOOKBACK_YEARS ago is
  // noted on the memo but does not stop payment; anything recent, open or undated does.
  const year = new Date().getUTCFullYear();
  const old = (s) => {
    const years = [...s.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => Number(m[0]));
    return (
      years.length > 0 &&
      Math.max(...years) <= year - LOOKBACK_YEARS &&
      /\b(settled|settlement|resolved|closed|concluded|paid)\b/i.test(s) &&
      !/\b(ongoing|pending|currently|still|open)\b/i.test(s)
    );
  };
  const hit = hits.find((s) => !old(s));
  if (!hit && hits.length)
    return finding(
      'Adverse media',
      'pass',
      `Only a matter settled more than ${LOOKBACK_YEARS} years ago, noted for the file: "${hits[0].slice(0, 220)}"`,
      p,
    );
  return hit
    ? finding('Adverse media', 'review', `A search answer ties the supplier to a risk term, so a person should read it: "${hit.slice(0, 220)}"`, p)
    : finding('Adverse media', 'pass', 'No risk term next to the supplier’s name in the search answer.', p);
}

/**
 * How the invoice asks to be paid, read from the case without a paid ask. Two of the
 * commonest marketplace payment frauds: the supplier asks to be paid outside the
 * marketplace's own escrow (Alibaba.com's Trade Assurance covers only orders paid through
 * it), and the bank account belongs to someone other than the supplier.
 */
export function paymentTerms(c, legalName) {
  const pay = c.payment;
  if (!pay) return [];
  const out = [];
  if (pay.channel && pay.channel !== 'trade_assurance')
    out.push(
      finding(
        'Payment channel',
        'review',
        `The invoice asks for payment ${pay.channel === 'bank_transfer' ? 'by direct bank transfer' : `by ${pay.channel}`} outside ${pay.marketplace ?? 'the marketplace'}'s ${pay.protection ?? 'buyer protection'}, so the order loses that protection: confirm the change with the supplier through the marketplace before paying.`,
        null,
      ),
    );
  if (pay.beneficiary) {
    const names = [c.name, legalName].filter(Boolean);
    if (!names.some((n) => sameName(n, pay.beneficiary)))
      out.push(
        finding(
          'Payee',
          'fail',
          `The bank account belongs to "${pay.beneficiary}", not to "${legalName ?? c.name}": an invoice that pays someone other than the supplier is held until the supplier confirms the account through a channel already on file.`,
          null,
        ),
      );
  }
  return out;
}

export function decide(findings) {
  if (findings.some((f) => f.status === 'fail')) return 'HOLD';
  if (findings.some((f) => f.status === 'review' || f.status === 'unanswered')) return 'REVIEW';
  return 'RELEASE';
}

export async function investigate(c) {
  // One ask at a time: asks paid from the same escrow account at the same moment were
  // rejected by the facilitator ("Payment was rejected"), while the same asks in turn pass.
  const steps = [
    () => registry(c),
    () => sanctions(c.name, 'company'),
    ...(c.officers ?? []).map((o) => () => sanctions(o, o)),
    () => website(c),
    () => fx(c),
    () => adverseMedia(c),
  ];
  const findings = [];
  for (const step of steps) {
    const f = await step();
    if (f) findings.push(f);
  }
  // The supplier's legal name only when the registry answered about the supplier itself.
  const reg = findings.find((f) => f.check === 'Registry record');
  const legal = reg?.status === 'pass' ? reg.purchase?.result?.legal_name : undefined;
  findings.push(...paymentTerms(c, legal));
  const cost = findings.reduce((s, f) => s + (Number(f.purchase?.cost_usd) || 0), 0);
  return {
    supplier: c.name,
    decision: decide(findings),
    reasons: findings.filter((f) => f.status !== 'pass').map((f) => f.summary),
    findings,
    paid_asks: findings.filter((f) => f.purchase?.receipt).length,
    cost_usd: Math.round(cost * 100) / 100,
  };
}
