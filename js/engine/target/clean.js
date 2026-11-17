// Effacer l'historique d'une réception et nettoyer son journal, sur demande (bouton de la carte CIBLE ; la SOURCE l'appelle aussi
// pour les journaux de retour d'un Échange, voir source/history.js). Aucun passage ne le fait seul (décision du porteur, 12 novembre :
// pas de purge automatique).
//
// Ce qui part (voir logic/clean.js) : l'avant de chaque modification et le numéro des lignes supprimées (`Sync_Avant`), les valeurs de
// la dernière version d'une clé supprimée ou partie de la SOURCE. Ce qui est noté : l'heure (`histo` dans la note du journal), avant
// laquelle l'historique de la carte ne montre plus rien. Ce qui reste : les lignes d'ici, la dernière version de chaque clé avec sa clé,
// son heure et son état (elles décident encore de ce qui est recopié), les listes et les marques d'application. L'historique propre à
// Grist (Ctrl+Z, « Historique du document ») n'est pas touché : le widget n'y a pas accès.
//
// Les valeurs vidées sont dans le sceau d'une version (voir logic/trust.js) : la ligne est rescellée avec la clé de signature de
// l'export, sans quoi le passage suivant la prendrait pour une ligne forgée. Sans clé (lien public, réception d'avant la 0.8) : rien à sceller.
import { BEFORE_COL, DATA_COL, SEAL_COL, chunk, nowS } from '../logic/common.js';
import { cleanPlan } from '../logic/clean.js';
import { journalNote } from '../logic/received.js';
import { sealRows } from '../logic/trust.js';
import { apply, fetchRows, readSchema, withLock } from '../port.js';
import { updateJournalNote } from './journals.js';
import { sealing, sealsSeen } from './loop.js';

// Rend { before, values } : combien de cellules d'avant et de lignes supprimées ont été vidées, ou null si ce n'est pas une réception.
export const cleanJournal = journal => withLock('gristsync-consolidation', async () => {
  const schema = await readSchema();
  const note = journalNote(schema, journal);
  if (!note || !note.export || !Array.isArray(note.tables)) return null;
  const rows = await fetchRows(journal);
  const plan = cleanPlan(rows, { hub: note.mode === 'echange' });
  const { seal } = await sealing(schema, journal, note);
  const byId = new Map(rows.map(r => [r.id, r]));
  const blanked = seal ? await sealRows(plan.values.map(id => ({ ...byId.get(id), [DATA_COL]: '' })), note.export, seal) : plan.values.map(id => ({ ...byId.get(id), [DATA_COL]: '' }));
  const actions = [
    ...chunk(plan.before).map(part => ['BulkUpdateRecord', journal, part, { [BEFORE_COL]: part.map(() => '') }]),
    ...chunk(blanked).map(part => ['BulkUpdateRecord', journal, part.map(r => r.id), {
      [DATA_COL]: part.map(() => ''),
      ...(seal ? { [SEAL_COL]: part.map(r => r[SEAL_COL]) } : {}),
    }]),
  ];
  if (actions.length) await apply(actions);
  sealsSeen.delete(journal);
  await updateJournalNote(journal, n => ({ ...n, histo: Math.floor(nowS()) }));
  return { before: plan.before.length, values: plan.values.length };
});
