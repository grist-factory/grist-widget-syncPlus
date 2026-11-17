// Diagnostic à copier, sans écran : relit le document et l'état des passages, puis le met en texte (choix de
// ce qui en fait partie et forme : logic/diagnostic.js). Le texte vient du port (`port.text`, clés `diag.*`).
// Jamais : une valeur de table, un courriel, une adresse de webhook ou de formulaire, un code, une clé, un
// identifiant de document (seulement l'instance).
//
//   diagnostic({ version, served, readOnly, agent })   rend le texte
//
// L'hôte dit ce que le moteur ne peut pas savoir : `version` de l'application, `served` (d'où elle est servie),
// `readOnly` (la personne ne fait que lire le document) et `agent` (le navigateur).
import { SYNC_TABLE, TYPE_COL, EXPORT_COL, TABLE_COL, RECEIVED_COL, RESEND_COL, nowS } from './logic/common.js';
import { ownsSync } from './logic/strays.js';
import { catchFact, diagnosticText, exportFacts, journalFacts, progressFact } from './logic/diagnostic.js';
import { conditionExport, exportDrift, exportTables, hooksOf } from './logic/exports.js';
import { receivedJournals, receivedKey } from './logic/received.js';
import { LEASE_S, budgetWait, dueRows, parseCharge } from './logic/resend.js';
import { docIdentity, fetchRows, isOwner, journalStats, listWebhooks, page, readSchema, t as portText, webhookConditions } from './port.js';
import { recentErrors } from './errors.js';
import { catchState } from './source/resend.js';
import { isCharge, readSourceNote } from './source/synchro.js';
import { comparing, state, tableKey } from './target/loop.js';

// Le texte du port, sans les espaces insécables de la typographie (français) : le diagnostic se colle dans un
// message ou un ticket, où une espace insécable gêne une recherche.
const t = (key, values) => portText(key, values).replace(/[\u00a0\u202f]/g, ' ');

async function sourceFacts(schema) {
  if (!ownsSync(schema)) return null;
  const owner = await isOwner().catch(() => false);
  const [hooks, conditions] = owner ? await Promise.all([listWebhooks(), webhookConditions()]) : [[], new Map()];
  const all = await fetchRows(SYNC_TABLE);
  const rows = all.filter(r => !isCharge(r));
  const note = readSourceNote(schema);
  const { late, lists } = dueRows(rows);
  const ids = [...new Set([...note.exports.map(e => e.id), ...rows.map(r => r[EXPORT_COL])])].filter(Boolean);
  const exports = ids.map((id) => {
    const tables = exportTables(rows, id);
    const of = list => list.filter(r => r[EXPORT_COL] === id).map(r => r[TABLE_COL]);
    return exportFacts({
      ...(note.exports.find(e => e.id === id) || { id, name: '' }), tables, ...exportDrift(schema, tables),
      invitations: note.invitations.filter(i => i.export === id), late: of(late), lists: of(lists), recipients: hooksOf(hooks, conditions, id),
    }, t);
  });
  const charge = parseCharge((all.find(isCharge) || {})[RESEND_COL]);
  const now = nowS();
  const busy = charge.par && now - charge.le < LEASE_S ? t('diag.charge.alive', { n: String(Math.round(now - charge.le)) }) : '';
  const wait = budgetWait(charge, now);
  return {
    ownerOnly: !owner,
    unsafe: hooks.filter(h => h.fields.tableId === SYNC_TABLE && !conditionExport(conditions.get(h.id))).length,
    charge: [busy, wait ? t('diag.charge.budget', { n: String(Math.round(wait)) }) : ''].filter(Boolean).join(', '),
    progress: progressFact(charge.prog, now, t),
    catchUp: catchFact(catchState(), t),
    exports,
    kinds: rows.reduce((n, r) => ({ ...n, [r[TYPE_COL]]: (n[r[TYPE_COL]] || 0) + 1 }), {}),
  };
}

async function targetFacts(schema) {
  const journals = await Promise.all(receivedJournals(schema).map(async ({ journal, note }) => journalFacts({
    journal, note, signed: receivedKey(schema, journal, note),
    results: [state.results.get(journal), ...note.tables.map(tb => state.results.get(tableKey(journal, tb.table)))],
    offers: (state.offers.get(journal) || []).length,
    stats: await journalStats(journal, RECEIVED_COL, TYPE_COL),
    t,
  })));
  return { journals, compare: comparing(), visible: page.visible() };
}

export async function diagnostic({ version, served = '', readOnly = false, agent = '' }) {
  const schema = await readSchema();
  const owner = await isOwner().catch(() => false);
  return diagnosticText({
    version,
    served,
    origin: await docIdentity().then(d => d.origin, () => ''),
    access: readOnly ? 'reader' : owner ? 'owner' : 'editor',
    at: Date.now(),
    agent,
    source: await sourceFacts(schema),
    target: await targetFacts(schema),
    errors: recentErrors,
    t,
  });
}
