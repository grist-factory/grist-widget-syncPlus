// Échange : deux documents qui se tiennent à jour l'un l'autre (voir planConsolidation). Chacun a
// un export (même identifiant des deux côtés, avec sa ligne 'echange') et un journal en mode
// 'echange' qui reçoit l'autre. Le journal de retour du document qui a invité (`retour`) attend
// la réponse (`from` encore vide) avant de recopier quoi que ce soit.
import { SYNC_TABLE } from './logic/common.js';
import { deleteColumnAction, keyTriggerAction, missingSyncColumns, prepareSourceActions } from './logic/formulas.js';
import { exchangeTables, exportCondition, exportTables, exportableColumns, hookName, hooksOf } from './logic/exports.js';
import { apply, createWebhook, deleteWebhook, listWebhooks, readSchema, webhookConditions } from './grist.js';
import { removeTechnicalTables } from './pages.js';
import { removeExport, saveExport, syncRows, updateSourceNote } from './source/synchro.js';
import { receivedJournals } from './target/journals.js';

// Côté CIBLE : l'export de retour (identifiant et nom de l'export reçu) envoie les destinations à
// la SOURCE. Elles reçoivent MajLe et RecalculLe, et une clé à chaque ligne nouvelle ; les lignes
// déjà là sans clé restent à ce document. Avec `retour` (adresse d'écriture du journal de retour,
// lue dans l'invitation, jamais notée), le webhook vers la SOURCE est (re)créé.
export async function wireExchange(note, retour = '') {
  let schema = await readSchema();
  for (const { dest } of note.tables) {
    const cols = schema.columns(dest) || [];
    await apply([...prepareSourceActions(dest, missingSyncColumns(cols)), keyTriggerAction(dest, cols), deleteColumnAction(dest, cols)].filter(Boolean));
  }
  schema = await readSchema();
  await saveExport(note.export, exchangeTables(note.tables, dest => exportableColumns(schema.columns(dest) || [])), { swap: true });
  await updateSourceNote((n) => {
    const was = n.exports.find(e => e.id === note.export) || { at: Date.now() / 1000 };
    n.exports = [...n.exports.filter(e => e.id !== note.export), { ...was, id: note.export, name: note.name, echange: true, retour: true }];
  });
  if (!retour) return;
  const [hooks, conditions] = await Promise.all([listWebhooks(), webhookConditions()]);
  for (const h of hooksOf(hooks, conditions, note.export)) await deleteWebhook(h.id);
  const from = note.from || {};
  await createWebhook({
    name: hookName(note.name, note.export), memo: [from.email, from.docId].filter(Boolean).join(' · '), url: retour,
    tableId: SYNC_TABLE, condition: exportCondition(note.export),
  });
}

// Échange, côté du document qui invite : ses tables reçoivent la case Supprime.
export async function addDeleteColumns(tables) {
  const schema = await readSchema();
  await apply(tables.map(table => deleteColumnAction(table, schema.columns(table) || [])).filter(Boolean));
}

// Fin d'un Échange, de ce côté : ses webhooks et son journal sont effacés, les tables gardent
// leurs lignes. `keepExport` (document qui a invité) : l'export reste, sans destinataire ; sinon
// (export de retour) il disparaît aussi.
export async function endExchange(exportId, { keepExport }) {
  const [hooks, conditions] = await Promise.all([listWebhooks(), webhookConditions()]);
  for (const h of hooksOf(hooks, conditions, exportId)) await deleteWebhook(h.id);
  const journals = receivedJournals(await readSchema()).filter(r => r.note.export === exportId && r.note.mode === 'echange');
  await removeTechnicalTables(journals.map(r => r.journal));
  if (keepExport) await saveExport(exportId, exportTables(await syncRows(), exportId));
  else await removeExport(exportId);
  await updateSourceNote((note) => {
    note.exports = keepExport ? note.exports.map(e => (e.id === exportId ? { ...e, echange: false } : e)) : note.exports.filter(e => e.id !== exportId);
    note.invitations = note.invitations.filter(i => i.export !== exportId);
    note.pauses = note.pauses.filter(p => p.export !== exportId);
  });
}
