// SOURCE : les clés `id_sync` des tables envoyées. Une ligne sans clé ne part pas, deux lignes de même clé
// n'en font qu'une chez les destinataires (voir logic/keys.js) : le moteur les compte (une requête, rien
// n'est lu en dehors des nombres) et donne une clé neuve à ces lignes, qui repartent. L'avis et le bouton
// sont dans l'écran (js/source/keys.js).
import { KEY_COL, ORDER_COL, chunk, nowS } from '../logic/common.js';
import { fillKeyActions, missingSyncColumns, prepareSourceActions } from '../logic/formulas.js';
import { keyCountSql, keyCounts, keyProblems, repairActions } from '../logic/keys.js';
import { apply, fetchRows, querySql, readSchema, selectRows } from '../port.js';

// Comptes par table, relus au plus une fois par minute (l'onglet se redessine souvent) ; null : rien à signaler.
const CHECK_MS = 60000;
const checked = new Map(); // table -> { at, counts }

// Ce qui ne va pas dans `tables` : Map(table -> { rows, blank, dup, missing }) sans les tables en règle. `missing` :
// colonnes du widget (id_sync, MajLe, RecalculLe) qu'une personne a supprimées de la table ; sans elles les lignes ne
// partent plus. Une table absente n'est pas dite ici (voir exportDrift).
export async function checkKeys(tables) {
  const found = new Map();
  const schema = await readSchema();
  await Promise.all([...new Set(tables)].filter(table => schema.has(table)).map(async (table) => {
    const missing = missingSyncColumns(schema.columns(table));
    const was = checked.get(table);
    let counts = was && Date.now() - was.at < CHECK_MS ? was.counts : undefined;
    if (counts === undefined) {
      // Sans la colonne id_sync, SQLite lirait "id_sync" comme un texte, le même pour toutes les lignes.
      const sql = missing.includes(KEY_COL) ? null : keyCountSql(table);
      const rows = sql ? await querySql(sql) : null;
      if (!rows && !missing.length) return; // Grist refuse (table absente, droits) : rien n'est dit
      counts = rows ? keyCounts(rows[0]) : null;
      checked.set(table, { at: Date.now(), counts });
    }
    if (counts || missing.length) found.set(table, { rows: 0, blank: 0, dup: 0, ...counts, missing });
  }));
  return found;
}

// Toutes les lignes de la table avec leur clé (lecture légère, sinon la table entière).
const keyRows = async table => (await selectRows(table, [KEY_COL])) || fetchRows(table);

// Répare : remet les colonnes du widget supprimées (toutes les lignes reçoivent alors une clé neuve si id_sync
// manquait, et repartent), puis donne une clé neuve aux lignes sans clé et aux doubles (la plus ancienne garde la sienne), et les
// lignes touchées repartent comme après une modification. Rend le nombre de lignes renvoyées.
export async function repairKeys(table) {
  const missing = missingSyncColumns((await readSchema()).columns(table));
  if (missing.length) {
    await apply(prepareSourceActions(table, missing));
    checked.delete(table);
    if (missing.includes(KEY_COL)) {
      // Clés neuves pour toutes les lignes : elles repartent toutes comme après une modification (par tranches si la
      // table est grande, voir le rattrapage), sinon chez les destinataires rien ne porterait les nouvelles clés.
      const rows = await fetchRows(table);
      await apply(fillKeyActions(table, rows, () => crypto.randomUUID()));
      const now = nowS();
      await apply(chunk(rows.map(r => r.id)).map(ids => ['BulkUpdateRecord', table, ids, { [ORDER_COL]: ids.map(() => now) }]));
      return rows.length;
    }
  }
  const problems = keyProblems(await keyRows(table));
  if (!problems.touch.length) return 0;
  await apply(repairActions(table, problems, { newId: () => crypto.randomUUID(), now: nowS(), order: ORDER_COL }));
  checked.delete(table);
  return problems.touch.length;
}
