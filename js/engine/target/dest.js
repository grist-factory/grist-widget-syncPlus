// CIBLE : les règles qu'une destination doit respecter. Le choix de la destination, la correspondance
// des colonnes et les fenêtres sont dans l'écran (js/target/dest.js).
import { EXPORT_COL, TABLE_COL } from '../logic/common.js';
import { destProblem } from '../logic/journal.js';
import { receivedDests } from '../logic/received.js';
import { docIdentity } from '../port.js';
import { failure } from '../errors.js';
import { syncRows } from '../source/synchro.js';

// Une destination ne reçoit qu'une table, d'un seul export, et n'est ni une table du widget, ni
// une table que ce document envoie lui-même (ses lignes, absentes des listes de la SOURCE, y
// seraient effacées ; le relais, lui, reçoit d'abord puis envoie). Copie dans le même document :
// une table ne peut pas se recevoir elle-même (`plans` : [{ table, dest }]). Échange (`exportId`) :
// une table que ce document envoie dans le même Échange peut recevoir.
export async function checkDests(schema, plans, fromDocId, exportId = null) {
  const problem = destProblem(plans, receivedDests(schema));
  if (problem) throw failure(problem.code, problem.vars);
  const dests = plans.map(p => p.dest);
  const sent = new Set((await syncRows(schema)).filter(r => !exportId || r[EXPORT_COL] !== exportId).map(r => r[TABLE_COL]));
  if (dests.some(d => sent.has(d))) throw new Error('destExported');
  if (fromDocId && fromDocId === (await docIdentity()).docId && plans.some(p => p.dest === p.table)) throw new Error('loop');
}
