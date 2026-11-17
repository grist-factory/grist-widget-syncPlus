// SOURCE : mise en pause d'un destinataire, à la main (carte de l'export) ou par le widget quand son lien de
// réception est mort. La file d'envoi de Grist est commune au document : un envoi qui échoue est retenté pendant un
// quart d'heure et tous les autres destinataires attendent derrière lui ; avec assez de destinataires ou de
// modifications, la file de 1 000 envois se remplit et Grist fait attendre les écritures de tous les utilisateurs du
// document (vu au test de charge : 256 destinataires, un mort, dix modifications de suite). Désactiver un webhook
// vide sa part de la file (Grist), ce qui libère les autres tout de suite.
import { ORDER_COL } from '../logic/common.js';
import { autoPauseKind, conditionExport, exportTables, hookLabel } from '../logic/exports.js';
import { setPause } from '../logic/notes.js';
import { fetchRows, setWebhookEnabled } from '../port.js';
import { recordEvent, syncRows, updateSourceNote } from './synchro.js';

// Mise en pause : un webhook désactivé perd son historique d'envoi (Grist remet son état à zéro),
// il ne peut donc pas dire depuis quand il ne livre plus. On note la plus récente MajLe des tables
// de l'export (heure du serveur, sans écart d'horloge avec le navigateur) et leurs colonnes.
// `auto` : la pause vient du widget ('link' ou 'slow', voir autoPauseKind), la carte le dit.
export async function pauseHook(exportId, tables, h, { auto = '' } = {}) {
  let at = 0;
  for (const { table } of tables) for (const r of await fetchRows(table).catch(() => [])) at = Math.max(at, r[ORDER_COL] || 0);
  await updateSourceNote(note => setPause(note, h.id, { hook: h.id, export: exportId, at, columns: JSON.stringify(tables), ...(auto ? { auto: true, why: auto } : {}) }));
  await setWebhookEnabled(h.id, false);
  await recordEvent(exportId, auto ? 'autopause' : 'pause', { who: hookLabel(h.fields.memo) });
}

// Un lien de réception mort (404, 401, 403) ou un envoi qui n'obtient jamais de réponse ne reviennent pas tout seuls :
// au bout de DEAD_MS vus ainsi sans interruption, le widget (page d'un propriétaire ouverte) met le destinataire en
// pause. Les erreurs qui passent d'elles-mêmes (quota, serveur en panne) ne sont jamais mises en pause d'office.
// Rend le nombre de destinataires mis en pause.
export const DEAD_MS = 60000;
const deadSince = new Map(); // webhook -> première fois vu mort
export async function pauseDeadLinks(hooks, conditions, now = Date.now()) {
  let paused = 0;
  for (const h of hooks) {
    const kind = autoPauseKind(h, now);
    if (!kind) { deadSince.delete(h.id); continue; }
    if (!deadSince.has(h.id)) { deadSince.set(h.id, now); continue; }
    const exportId = conditionExport(conditions.get(h.id));
    if (now - deadSince.get(h.id) < DEAD_MS || !exportId) continue;
    await pauseHook(exportId, exportTables(await syncRows(), exportId), h, { auto: kind });
    deadSince.delete(h.id);
    paused++;
  }
  return paused;
}
