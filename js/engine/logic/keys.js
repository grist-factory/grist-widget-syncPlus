// Logique pure : clés `id_sync` des lignes d'une table envoyée. (Ni DOM, ni `grist`, ni réseau.)
//
// La clé fait l'identité d'une ligne chez les destinataires : une ligne sans clé ne part pas (le lot et la
// liste des clés la passent), et deux lignes de même clé n'en font qu'une chez eux (la plus récemment
// modifiée gagne, l'autre n'arrive jamais). Dupliquer une ligne dans Grist, coller des lignes entières ou
// effacer des cellules de la colonne en fabrique ; la formule `UUID()` ne pose la clé qu'à la création.
// Rien ne le disait : la SOURCE et la CIBLE affichaient « à jour » avec des lignes en moins (vu au test de
// charge : 20 lignes sur 2 005).
import { KEY_COL, isBlank, isSafeId, chunk } from './common.js';

// Requête qui compte, sans rien lire d'autre : lignes, lignes sans clé, clés distinctes. Null si le nom de
// la table ne peut pas s'écrire sans risque.
export const keyCountSql = table => (isSafeId(table)
  ? `select count(*) as n, sum(case when trim("${KEY_COL}") is null or trim("${KEY_COL}") = '' then 1 else 0 end) as blank, count(distinct case when trim("${KEY_COL}") = '' then null else "${KEY_COL}" end) as keys from "${table}"`
  : null);

// Ce que dit la requête : { rows, blank, dup } ; `dup` : lignes en trop qui partagent la clé d'une autre.
// null s'il n'y a rien à signaler.
export function keyCounts(result) {
  const rows = Number(result && result.n) || 0;
  const blank = Number(result && result.blank) || 0;
  const keys = Number(result && result.keys) || 0;
  const dup = Math.max(0, rows - blank - keys);
  return blank || dup ? { rows, blank, dup } : null;
}

// Lignes à réparer, d'après toutes les lignes de la table (`rows` : { id, id_sync }) : celles sans clé
// (`blank`) et, dans chaque groupe de même clé, toutes sauf la plus ancienne (`dup`), qui garde la clé. Les
// lignes à renvoyer (`touch`) sont celles qui changent de clé et celles qui gardent la clé d'un groupe, dont
// le contenu doit repartir pour que les destinataires aient la bonne version.
export function keyProblems(rows) {
  const groups = new Map();
  const blank = [];
  for (const row of rows) {
    if (isBlank(row[KEY_COL])) blank.push(row.id);
    else groups.set(row[KEY_COL], [...(groups.get(row[KEY_COL]) || []), row.id]);
  }
  const dup = [];
  const keep = [];
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const [first, ...others] = ids.sort((a, b) => a - b);
    keep.push(first);
    dup.push(...others);
  }
  return { blank, dup, keep, touch: [...blank, ...dup, ...keep] };
}

// Écritures de la réparation : une clé neuve (`newId`) pour les lignes sans clé et les doubles, et
// l'heure de modification (`now`, secondes) de toutes les lignes à renvoyer, comme le ferait une modification
// ordinaire : le lot de la SOURCE les envoie alors seul. `order` : colonne de l'heure de modification.
export function repairActions(table, { blank, dup, keep }, { newId, now, order }) {
  const fresh = [...blank, ...dup];
  return [
    ...chunk(fresh).map(ids => ['BulkUpdateRecord', table, ids, { [KEY_COL]: ids.map(() => newId()), [order]: ids.map(() => now) }]),
    ...chunk(keep).map(ids => ['BulkUpdateRecord', table, ids, { [order]: ids.map(() => now) }]),
  ];
}
