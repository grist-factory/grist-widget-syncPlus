// Échange : deux documents qui se tiennent à jour l'un l'autre (voir planConsolidation). Chacun a
// un export (même identifiant des deux côtés, avec sa ligne 'echange') et un journal en mode
// 'echange' qui reçoit l'autre. Le journal de retour du document qui a invité (`retour`) attend
// la réponse (`from` encore vide) avant de recopier quoi que ce soit.
// Échange à plusieurs : le document qui invite en administre plusieurs à la fois, chacun avec son
// webhook et son journal de retour ; les participants ne se connaissent pas (voir markHub).
import { EXPORT_COL, HUB, KIND, SCHEMA_COL, SYNC_TABLE, TYPE_COL, nowS } from './logic/common.js';
import { deleteColumnAction, keyTriggerAction, missingSyncColumns, prepareSourceActions } from './logic/formulas.js';
import { exportCondition, exportTables, hookMemo, hookName, ownJournal, returnExportTables } from './logic/exports.js';
import { clearExport, dropExport, putExport, setExport, setPause } from './logic/notes.js';
import { apply, createWebhook, deleteWebhook, deleteWebhookWithNotice, readSchema } from './port.js';
import { removeTechnicalTables } from './pages.js';
import {
  endRows, exportHooks, pruneKeys, putRecipientKey, readSourceNote, rememberDest, removeExport, saveExport, setOnlyKey, syncRows, updateSourceNote,
} from './source/synchro.js';
import { receivedJournals } from './logic/received.js';

const PENDING_LABEL = 'retour'; // clé de retour, le temps de créer son webhook

// Côté CIBLE : l'export de retour (identifiant et nom de l'export reçu) envoie les destinations à
// la SOURCE. Elles reçoivent MajLe et RecalculLe, et une clé à chaque ligne nouvelle ; les lignes
// déjà là sans clé restent à ce document. Avec `retour` (adresse d'écriture du journal de retour,
// lue dans l'invitation, jamais notée), le webhook vers la SOURCE est (re)créé ; `key` signe ses
// envois (clé de retour tirée de l'échange de clés publiques, voir linkKeys).
export async function wireExchange(note, retour = '', key = '') {
  let schema = await readSchema();
  for (const { dest } of note.tables) {
    const cols = schema.columns(dest) || [];
    await apply([...prepareSourceActions(dest, missingSyncColumns(cols)), keyTriggerAction(dest, cols), deleteColumnAction(dest, cols)].filter(Boolean));
  }
  schema = await readSchema();
  // Jamais par-dessus un export d'ici qui n'est pas ce retour (voir readInvitation, target/wizard.js).
  const local = readSourceNote(schema).exports.find(e => e.id === note.export);
  if (local && !local.retour) throw new Error('exportTaken');
  await saveExport(note.export, returnExportTables(note, schema), { swap: true });
  await updateSourceNote((n) => {
    const was = n.exports.find(e => e.id === note.export) || { at: nowS() };
    return putExport(n, { ...was, id: note.export, name: note.name, echange: true, retour: true });
  });
  if (!retour) return;
  for (const h of await exportHooks(note.export)) await deleteWebhook(h.id);
  // L'envoi de retour est signé par une clé que seuls ce document et l'autre côté tirent de leurs
  // clés publiques, et ce que l'autre côté en déplie est scellé avec elle (voir trust.js) :
  // l'invitation seule, qui porte l'adresse de retour, ne suffit pas pour y faire recopier quoi que
  // ce soit. Posée avant le webhook, qui ne part donc jamais sans elle.
  await setOnlyKey(note.export, PENDING_LABEL, key);
  const hookId = await createWebhook({
    name: hookName(note.name, note.export), memo: await rememberDest(hookMemo(note.from || {})), url: retour,
    tableId: SYNC_TABLE, condition: exportCondition(note.export),
  });
  await putRecipientKey(note.export, hookId, key, PENDING_LABEL);
}

// Échange à plusieurs : la ligne 'echange' de l'export est marquée dès deux participants (webhooks
// de l'export) ; la formule du lot renvoie alors aux autres ce que chacun envoie. Un seul : l'Échange
// à deux, sans écho.
export async function markHub(exportId) {
  const [hooks, rows] = await Promise.all([exportHooks(exportId), syncRows()]);
  const value = hooks.length >= 2 ? HUB : '';
  const row = rows.find(r => r[EXPORT_COL] === exportId && r[TYPE_COL] === KIND.swap);
  if (row && (row[SCHEMA_COL] || '') !== value) await apply([['UpdateRecord', SYNC_TABLE, row.id, { [SCHEMA_COL]: value }]]);
}

// Retirer un destinataire, ou un participant d'un Échange à plusieurs : son webhook part (avec
// l'avis de fin, qui arrête aussi l'envoi de retour d'un participant, voir stopReturn), puis son
// journal de retour et sa clé ; les autres continuent.
export async function removeRecipient(exportId, hook) {
  await deleteWebhookWithNotice(hook, await endRows(exportId, hook.id));
  await pruneKeys(exportId);
  const journals = receivedJournals(await readSchema()).filter(r => r.note.export === exportId && r.note.retour).filter(ownJournal(hook));
  await removeTechnicalTables(journals.map(r => r.journal));
  await updateSourceNote(note => setPause(note, hook.id));
  await markHub(exportId);
}

// Échange coupé par l'autre document : son journal de retour n'existe plus, chaque envoi de retour
// échouerait et bloquerait la file de ce document. L'envoi de retour s'arrête donc ici aussi
// (propriétaire seulement ; sinon, au premier passage d'un propriétaire).
export async function stopReturn(exportId) {
  for (const h of await exportHooks(exportId)) await deleteWebhook(h.id);
}

// Échange, côté du document qui invite : ses tables reçoivent la case Supprime.
export async function addDeleteColumns(tables) {
  const schema = await readSchema();
  await apply(tables.map(table => deleteColumnAction(table, schema.columns(table) || [])).filter(Boolean));
}

// Fin d'un export ou d'un Échange, de ce côté : ses webhooks (après l'avis de fin) et ses journaux
// de retour sont effacés, les tables gardent leurs lignes. `keepExport` (Échange, document qui a
// invité) : l'export reste, sans destinataire ni Échange ; sinon il disparaît (export supprimé,
// export de retour d'un Échange).
export async function closeExport(exportId, { keepExport }) {
  for (const h of await exportHooks(exportId)) await deleteWebhookWithNotice(h, await endRows(exportId, h.id));
  if (keepExport) await pruneKeys(exportId);
  const journals = receivedJournals(await readSchema()).filter(r => r.note.export === exportId && r.note.mode === 'echange');
  await removeTechnicalTables(journals.map(r => r.journal));
  if (keepExport) await saveExport(exportId, exportTables(await syncRows(), exportId));
  else await removeExport(exportId);
  await updateSourceNote(note => (keepExport ? setExport(clearExport(note, exportId), exportId, { echange: false }) : dropExport(note, exportId)));
}
