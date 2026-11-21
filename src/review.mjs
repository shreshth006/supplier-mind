/**
 * The Reviewer: a second Mind that reads the Investigator's memo cold and asks whether
 * each pass is really earned. It can only move the decision down (RELEASE -> REVIEW ->
 * HOLD), never up, and says why for every change.
 *
 *  1. A pass with no receipt or no Provider is not evidence: REVIEW.
 *  2. A pass that rests on a field the Provider did not return (registry "active") is
 *     not a pass: REVIEW.
 *  3. When the registry's legal name differs from the name screened, the legal name is
 *     screened too, since a list entry is under the legal name.
 *  4. The registry is checked against GLEIF directly (free, the LEI system's own record):
 *     a lapsed LEI is REVIEW, a retired or inactive entity is HOLD.
 */
import { ask } from './anjoman.mjs';
import { decide, isLei, sameName, scanVerdict } from './investigate.mjs';

/**
 * Providers that scan URLs, asked for a second opinion when the first scan came from
 * someone else. ChainSight (miner 302) answered the Safe Browsing phishing test page as
 * unsafe on 2026-11-20 when another scanner called it safe.
 */
const SECOND_SCANNERS = ['302'];

/** The registrable part of a host: www.siemens.com -> siemens.com, a.b.co.uk -> b.co.uk. */
function site(url) {
  try {
    const parts = new URL(url).hostname.toLowerCase().split('.');
    const two = /^(co|com|org|net|gov|ac)$/.test(parts.at(-2) ?? '') && parts.length > 2 ? 3 : 2;
    return parts.slice(-two).join('.');
  } catch {
    return null;
  }
}

/** Whether a domain carries a distinctive word of the supplier's name (siemens.com, Siemens AG). */
function ownDomain(domain, name) {
  const words = String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !/^(group|holding|holdings|gmbh|limited|corp|company|international|europe|global)$/.test(w));
  return words.some((w) => domain.replace(/[^a-z0-9]/g, '').includes(w));
}

const RANK = { RELEASE: 0, REVIEW: 1, HOLD: 2 };
const worse = (a, b) => (RANK[a] >= RANK[b] ? a : b);

const plain = (x) =>
  String(x ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

/** Every name GLEIF records for an entity: its legal name, other and transliterated names. */
const namesOf = (a) => [
  a.entity.legalName?.name,
  ...(a.entity.otherNames ?? []).map((n) => n.name),
  ...(a.entity.transliteratedOtherNames ?? []).map((n) => n.name),
].filter(Boolean);

/**
 * The supplier's GLEIF record: by LEI when one is known, else by the national register
 * number the registry answer gave, else by any of its names, and only a record whose
 * names include the supplier's. A legal-name search for "Hangzhou Hikvision Digital
 * Technology Co., Ltd." (its GLEIF legal name is in Chinese) came back with an unrelated
 * "TRANSLINK (LTD) LTD", reported as GLEIF's record.
 */
export async function gleif(lei, name, registrationId, alsoName) {
  const base = 'https://api.gleif.org/api/v1/lei-records';
  const named = (a) => namesOf(a).some((n) => sameName(n, name) || (alsoName && sameName(n, alsoName)));
  const urls = /^[A-Z0-9]{20}$/.test(lei ?? '')
    ? [`${base}/${lei}`]
    : [
        ...(registrationId
          ? [`${base}?filter%5Bentity.registeredAs%5D=${encodeURIComponent(registrationId)}&page%5Bsize%5D=5`]
          : []),
        `${base}?filter%5Bentity.names%5D=${encodeURIComponent(name)}&page%5Bsize%5D=5`,
      ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) continue;
      const d = await res.json();
      const recs = Array.isArray(d.data) ? d.data : d.data ? [d.data] : [];
      // A record fetched by its LEI is that entity; a search hit must carry the name.
      const rec = Array.isArray(d.data) ? recs.find((x) => named(x.attributes)) : recs[0];
      if (!rec) continue;
      const a = rec.attributes;
      return {
        lei: a.lei,
        legal_name: a.entity.legalName.name,
        names: namesOf(a),
        entity_status: a.entity.status,
        registration_status: a.registration.status,
        next_renewal: a.registration.nextRenewalDate,
        registered_as: a.entity.registeredAs ?? null,
        source: `https://search.gleif.org/#/record/${a.lei}`,
      };
    } catch {
      // the next lookup, or none
    }
  }
  return null;
}

export async function review(memo, c) {
  const changes = [];
  const extra = [];
  const flag = (check, to, why) => changes.push({ check, to, why });

  for (const f of memo.findings) {
    if (f.status !== 'pass') continue;
    if (f.purchase && (!f.purchase.receipt?.receipt_hash || !f.purchase.miner_name))
      flag(f.check, 'review', 'This pass has no receipt or no named Provider, so it cannot be audited.');
    const fs = f.purchase?.field_status ?? {};
    if (f.check === 'Registry record' && fs.active && fs.active !== 'ok')
      flag(f.check, 'review', 'The registry answer did not say whether the company is active, so "active" was not shown.');
  }

  const reg = memo.findings.find((f) => f.check === 'Registry record');
  const legal = reg?.purchase?.result?.legal_name;
  if (legal && !sameName(legal, c.name)) {
    const p = await ask('SANCTIONS_SCREENING_MATCH_GENERAL', { name: legal });
    const m = p.result?.matched;
    extra.push({
      check: `Sanctions: legal name "${legal}"`,
      status: m === true ? 'fail' : m === false ? 'pass' : 'unanswered',
      summary:
        m === true
          ? `The registry's legal name "${legal}" matches a sanctions entry.`
          : m === false
            ? `The registry's legal name "${legal}" has no sanctions match either.`
            : 'The legal-name screen gave no usable answer.',
      purchase: p,
    });
  }

  // The payment link: on the supplier's own domain, and safe by a second scanner too.
  const web = memo.findings.find((f) => f.check === 'Website');
  if (c.website) {
    const domain = site(c.website);
    if (domain && !ownDomain(domain, legal ?? c.name) && !ownDomain(domain, c.name))
      extra.push({
        check: 'Payment link domain',
        status: 'review',
        summary: `The payment link is on ${domain}, which is not a domain of "${c.name}": confirm the link with the supplier by a known phone number before paying (the usual sign of a swapped invoice link).`,
        purchase: null,
      });
    const first = web?.purchase?.miner_id;
    const other = SECOND_SCANNERS.find((m) => m !== first);
    if (other) {
      const p = await ask('URL_SCAN_VERDICT', { url: c.website }, { minerId: other });
      const safe = scanVerdict(p.result);
      const before = web?.status;
      extra.push({
        check: 'Website, second scanner',
        status: safe === false ? 'fail' : safe === true ? 'pass' : 'unanswered',
        summary:
          safe === false
            ? `A second scanner (${p.miner_name ?? `miner ${other}`}) calls ${c.website} unsafe${before === 'pass' ? `, against the first scanner's "safe"; the worse verdict stands` : ''}.`
            : safe === true
              ? `A second scanner (${p.miner_name ?? `miner ${other}`}) also calls ${c.website} safe.`
              : 'The second scan gave no usable answer.',
        purchase: p,
      });
    }
  }

  const r = reg?.purchase?.result ?? {};
  const g = await gleif(
    r.lei ?? (isLei(r.registration_id) ? r.registration_id : null),
    c.name,
    isLei(r.registration_id) ? null : r.registration_id,
    legal,
  );
  if (g) {
    // GLEIF has to confirm the supplier asked about, not whatever company the registry found.
    // Any of the entity's names counts: Hikvision's GLEIF legal name is in Chinese.
    const other = !g.names.some((n) => sameName(n, c.name) || (legal && sameName(n, legal)));
    // The registry answer's number is held against the national register number GLEIF
    // records: an LEI given as the registration number is corrected, and a number that
    // disagrees is for a person to settle (Siemens AG: the LEI came back as its number,
    // the register number is HRB 6684).
    const leiAsNumber = isLei(r.registration_id);
    const numberDiffers =
      !other &&
      !leiAsNumber &&
      r.registration_id &&
      g.registered_as &&
      plain(r.registration_id) !== plain(g.registered_as);
    const numberNote = other
      ? ''
      : leiAsNumber
        ? ` The registry answer gave the LEI as its registration number; the national register number is ${g.registered_as ?? 'not recorded in GLEIF'}.`
        : numberDiffers
          ? ` The registry answer's registration number ${r.registration_id} is not the ${g.registered_as} GLEIF records: confirm which register entry is the supplier's.`
          : g.registered_as
            ? ` Register number ${g.registered_as}.`
            : '';
    const status =
      other || numberDiffers
        ? 'review'
        : g.entity_status !== 'ACTIVE' || g.registration_status === 'RETIRED'
          ? 'fail'
          : g.registration_status === 'LAPSED'
            ? 'review'
            : 'pass';
    extra.push({
      check: 'Independent registry (GLEIF)',
      status,
      summary:
        (other
          ? `GLEIF's record is for "${g.legal_name}" (LEI ${g.lei}), not "${c.name}", so it does not confirm the supplier.`
          : status === 'fail'
            ? `GLEIF shows "${g.legal_name}" (LEI ${g.lei}) as entity ${g.entity_status}, registration ${g.registration_status}.`
            : g.registration_status === 'LAPSED'
              ? `GLEIF shows LEI ${g.lei} for "${g.legal_name}" as LAPSED: its reference data was due for renewal on ${String(g.next_renewal).slice(0, 10)} and has not been renewed. The entity is still ${g.entity_status}; ask the supplier to renew before paying.`
              : `GLEIF confirms "${g.legal_name}"${/^[\x00-\x7f]*$/.test(g.legal_name) ? '' : ` ("${g.names.find((n) => /^[\x00-\x7f]*$/.test(n)) ?? g.legal_name}")`} (LEI ${g.lei}): entity ${g.entity_status}, registration ${g.registration_status}.`) +
        numberNote,
      purchase: null,
      source: g.source,
      gleif: g,
      ...(leiAsNumber || numberDiffers ? { corrected: { registration_id: g.registered_as } } : {}),
    });
  } else {
    extra.push({
      check: 'Independent registry (GLEIF)',
      status: 'review',
      summary: `GLEIF has no LEI record for "${legal ?? c.name}", so the registry answer has no independent confirmation.`,
      purchase: null,
    });
  }

  const reviewed = memo.findings.map((f) => {
    const ch = changes.find((x) => x.check === f.check);
    return ch && f.status === 'pass' ? { ...f, status: ch.to, reviewer_note: ch.why } : f;
  });
  const all = [...reviewed, ...extra];
  const decision = worse(memo.decision, decide(all));
  const cost = extra.reduce((s, f) => s + (Number(f.purchase?.cost_usd) || 0), 0);
  return {
    decision,
    changed: decision !== memo.decision,
    from: memo.decision,
    changes,
    extra_findings: extra,
    reasons: all.filter((f) => f.status !== 'pass').map((f) => f.summary),
    cost_usd: Math.round(cost * 100) / 100,
  };
}
