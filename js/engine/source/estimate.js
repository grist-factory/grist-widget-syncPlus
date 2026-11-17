// SOURCE : ce qu'un envoi complet va coûter, calculé avant de le lancer (lignes qui partiront, poids,
// lots, durée). Le texte qui le dit à la personne est dans l'écran (js/source/flow.js).
import { EXPORT_COL, LIST_COL, SYNC_TABLE, TABLE_COL, TYPE_COL } from '../logic/common.js';
import { estimateSend, lineBytes } from '../logic/estimate.js';
import { eligibleRows } from '../logic/resend.js';
import { fetchRows, selectRows } from '../port.js';
import { readHooks } from './synchro.js';

// { rows, bytes, lots, seconds, recipients } pour l'envoi de toutes les lignes des tables de l'export
// (`exp.tables`) : lignes qui peuvent partir lues dans le suivi de Synchro (clé présente, filtre
// appliqué), poids d'après les 50 premières lignes de chaque table.
export async function exportEstimate(exp) {
  const sync = (await selectRows(SYNC_TABLE, [EXPORT_COL, TABLE_COL, TYPE_COL, LIST_COL])) || [];
  const recipients = (await readHooks()).of(exp.id).filter(h => h.fields.enabled).length;
  const tables = [];
  for (const tb of exp.tables) {
    const tableRows = await fetchRows(tb.table);
    const ids = tb.columns.map(c => c.id);
    const sample = tableRows.slice(0, 50).map(r => Object.fromEntries(ids.map(id => [id, r[id]])));
    tables.push({ rows: eligibleRows(sync, exp.id, tb.table) ?? tableRows.length, bytesPerLine: lineBytes(sample), all: tableRows.length });
  }
  return { ...estimateSend({ tables, recipients: Math.max(1, recipients) }), all: tables.reduce((n, tb) => n + tb.all, 0) };
}
