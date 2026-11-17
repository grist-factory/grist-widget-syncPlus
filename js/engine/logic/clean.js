// Nettoyage manuel d'un journal reçu (bouton « Effacer l'historique », voir target/clean.js). Logique pure.
//
// Ce que le journal garde en plus de ce qu'il faut pour recopier : l'avant de chaque modification et le numéro de ligne d'une
// suppression (`Sync_Avant`, qui nourrit l'historique de la carte) et les valeurs de la dernière version d'une clé supprimée ou
// partie de la SOURCE (la ligne n'est plus ici : sa version ne sert plus qu'à ordonner une version qui arriverait en retard).
// Les deux partent ; la clé, l'heure, la case Supprime et l'état de la version restent, ils décident encore.
import { BEFORE_COL, DATA_COL, STATE_COL, isBlank } from './common.js';
import { STATES, latestByKey, rowsByTable } from './journal.js';

// États dont la dernière version d'une clé n'a plus besoin de ses valeurs : la ligne est partie d'ici.
export const GONE_STATES = ['suppression', 'partie'];

// Ce qui est à vider : `before` (numéros de lignes dont `Sync_Avant` n'est pas vide, états montrés dans l'historique seulement :
// celui d'un changement refusé en Échange sert à le corriger) et `values` (numéros des dernières versions d'une clé partie dont
// les valeurs ne sont pas vides). `hub` : Échange (les lignes cochées Supprime y sont recopiées cochées, leurs valeurs servent
// à comparer : rien n'y est vidé).
export function cleanPlan(journalRows, { hub = false } = {}) {
  const before = journalRows.filter(r => !isBlank(r[BEFORE_COL]) && STATES.includes(r[STATE_COL])).map(r => r.id);
  const values = [];
  if (!hub) {
    for (const rows of rowsByTable(journalRows).values()) {
      for (const version of latestByKey(rows).values()) {
        if (GONE_STATES.includes(version.row[STATE_COL]) && !isBlank(version.row[DATA_COL])) values.push(version.id);
      }
    }
  }
  return { before, values };
}
