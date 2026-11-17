// Effacer l'historique d'un export, sur demande (bouton de l'onglet Envoyer, propriétaires). Aucun passage ne le fait seul.
// Part : l'historique des envois de la note SOURCE (voir clearEvents, qui garde des repères sans nom) et, pour un Échange, l'avant
// et les valeurs supprimées des journaux de retour de cet export (voir target/clean.js). Ne touche ni aux lignes envoyées, ni aux
// destinataires, ni à `Synchro`, ni à l'historique propre à Grist (Ctrl+Z, « Historique du document »).
import { clearEvents } from '../logic/notes.js';
import { receivedJournals } from '../logic/received.js';
import { readSchema } from '../port.js';
import { cleanJournal } from '../target/clean.js';
import { updateSourceNote } from './synchro.js';

// Rend { before, values } : ce qui a été vidé dans les journaux de retour de l'export.
export async function clearExportHistory(exportId) {
  await updateSourceNote(note => clearEvents(note, exportId));
  const back = receivedJournals(await readSchema()).filter(r => r.note.retour && r.note.export === exportId);
  const total = { before: 0, values: 0 };
  for (const { journal } of back) {
    const done = await cleanJournal(journal);
    if (done) { total.before += done.before; total.values += done.values; }
  }
  return total;
}
