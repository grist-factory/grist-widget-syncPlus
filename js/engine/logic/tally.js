// CIBLE : le bilan des lignes. Chaque lot que la SOURCE envoie annonce combien de clés sa table a
// (`bilan` : { n, t }, t = heure du dernier changement des clés). La CIBLE compte celles qu'elle a
// reçues et ne signale qu'un manque qui dure : un envoi perdu (Grist redémarré, file vidée) ne laisse
// sinon aucune trace, la carte restant « À jour » avec une table incomplète.
//
// Pas de fausse alerte en usage normal :
//  - seul un manque est signalé (reçues < annoncées) ; un surplus (une ligne cochée Supprime puis
//    effacée, une ligne gardée en archive) n'en est pas un ;
//  - un manque qui n'a pas bougé pendant TALLY_GRACE_S secondes de page ouverte (un envoi en route,
//    une liste de suppressions qui n'est pas encore passée, un lot qui arrive dans le désordre
//    changent les comptes avant) ;
//  - rien quand l'écart a déjà son avis (lignes à venir, trop grosses), ni en Échange (les deux
//    côtés écrivent), ni par lien public (instantané), ni en archive (les lignes parties restent).
import { DELETE_COL, STATE_COL, isTrue } from './common.js';
import { latestByKey } from './journal.js';

export const TALLY_GRACE_S = 600;

// Annonces notées dans le journal (`was`, par table) mises à jour d'après un dépliage (`announced`,
// par table) : la plus récente (t le plus grand) l'emporte, à égalité la dernière arrivée. Une table
// qui n'est plus reçue (`tables`) est oubliée ; au plus `max` tables.
export function nextTally(was = {}, announced = {}, tables = null, max = 200) {
  const next = { ...was };
  for (const [table, a] of Object.entries(announced)) {
    if (!next[table] || a.t >= next[table].t) next[table] = a;
  }
  const kept = Object.entries(next).filter(([table]) => !tables || tables.includes(table));
  return Object.fromEntries(kept.slice(-max));
}

// Nombre de clés que la SOURCE a encore, d'après les versions du journal (`tableRows` : lignes
// dépliées de la table) : la dernière version de chaque clé, sauf celle d'une clé partie de la SOURCE
// (marquée 'suppression' ou 'partie' sans case Supprime : la case, elle, laisse la ligne dans la
// table de la SOURCE, donc dans son compte).
const GONE = new Set(['suppression', 'partie']);
export function liveKeys(tableRows) {
  let n = 0;
  for (const { row } of latestByKey(tableRows).values()) {
    if (isTrue(row[DELETE_COL]) || !GONE.has(row[STATE_COL])) n++;
  }
  return n;
}

// Manque d'une table : { expected, got, gap } si la SOURCE annonce plus de clés qu'il n'en est arrivé,
// null sinon (pas d'annonce, ou compte complet, ou déjà expliqué par `explained`).
export function tallyGap(announce, tableRows, explained = false) {
  if (!announce || explained) return null;
  const got = liveKeys(tableRows);
  return got < announce.n ? { expected: announce.n, got, gap: announce.n - got } : null;
}

// Un manque est signalé une fois qu'il a duré TALLY_GRACE_S secondes sans changer (`seen` : table de
// suivi en mémoire de la page, `key` : réception et table). Rend vrai quand il faut le dire. Un manque
// qui change (autres annonces, autres arrivées) repart de zéro ; plus de manque, on oublie.
export function tallyDue(seen, key, gap, now, grace = TALLY_GRACE_S) {
  if (!gap) {
    seen.delete(key);
    return false;
  }
  const sign = `${gap.expected}:${gap.got}`;
  const was = seen.get(key);
  if (!was || was.sign !== sign) {
    seen.set(key, { sign, since: now });
    return false;
  }
  return now - was.since >= grace;
}
