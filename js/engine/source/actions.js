// SOURCE : ce que font les actions sur un export et ses destinataires (pause, reprise, révocation,
// suppression, invitation, lien public). Les demandes de confirmation et les fenêtres sont dans
// l'écran (js/source/actions.js), qui appelle ceci une fois la personne d'accord.
import { RESEND_ALL } from '../logic/common.js';
import { buildInvitation } from '../logic/codes.js';
import { rowsSince } from '../logic/resend.js';
import { docIdentity, fetchRows, readSchema, setWebhookEnabled } from '../port.js';
import { removeTechnicalTables } from '../pages.js';
import { dropInvitation, setExport, setPause } from '../logic/notes.js';
import { closeExport, removeRecipient } from '../exchange.js';
import { hookLabel } from '../logic/exports.js';
import { readSourceNote, recordEvent, saveExport, sourceFrom, updateSourceNote } from './synchro.js';
import { resendTables } from './resend.js';
import { pauseHook } from './pausing.js';

const AFTER_S = 0.0001; // juste après l'heure de la pause (MajLe en secondes)
const who = h => hookLabel(h.fields.memo);

// Mise en pause du destinataire `h` de l'export `exp` (voir pausing.js).
export const pauseRecipient = (exp, h) => pauseHook(exp.id, exp.tables, h);

// Reprendre après une pause : un webhook désactivé ne met rien en file, les changements de la
// pause sont donc perdus pour la CIBLE. Le rattrapage renvoie les lignes dont MajLe est plus
// récente que la pause, et la liste des clés pour les suppressions. Heure inconnue, ou colonnes
// changées pendant la pause : tout l'export. `resumePlan` dit ce que le rattrapage renverrait
// (`since` : la date, `n` : le nombre de lignes, `all` : tout l'export) ; `resumeRecipient` reprend,
// avec ce rattrapage (`catchup`) ou tel quel.
export async function resumePlan(exp, h) {
  const entry = readSourceNote(await readSchema()).pauses.find(p => p.hook === h.id);
  const all = !entry || entry.columns !== JSON.stringify(exp.tables);
  const since = all ? RESEND_ALL : entry.at + AFTER_S; // MajLe plus récente que la pause
  let n = 0;
  for (const { table } of exp.tables) n += rowsSince(await fetchRows(table), since).length;
  return { since, n, all };
}

export async function resumeRecipient(exp, h, { catchup, since }, progress) {
  await setWebhookEnabled(h.id, true);
  await updateSourceNote(note => setPause(note, h.id));
  await recordEvent(exp.id, 'resume', { who: who(h) });
  // Le renvoi pose sa marque avant tout : s'il s'interrompt, le rattrapage automatique le finit.
  if (catchup) await resendTables(exp.id, exp.tables.map(tb => tb.table), progress, since);
}

// Révoquer une personne : son webhook disparaît, les autres destinataires continuent ; sa carte le
// dit (voir endRows). Un Échange s'arrête dans les deux sens (voir closeExport) ; dans un Échange
// à plusieurs, pour ce participant seulement (voir removeRecipient). `revokesOne` : c'est le cas.
export const revokesOne = exp => Boolean(exp.echange && !exp.retour && exp.recipients.length > 1);

export async function revokeRecipient(exp, h) {
  await recordEvent(exp.id, 'revoke', { who: who(h) });
  if (exp.echange && !revokesOne(exp)) await closeExport(exp.id, { keepExport: !exp.retour });
  else await removeRecipient(exp.id, h);
}

// Annuler une invitation ; celle d'un Échange emporte son journal de retour (et la clé d'écriture
// de son formulaire).
export async function cancelPendingInvitation(inv) {
  await updateSourceNote(note => dropInvitation(note, inv.id));
  if (inv.journal) await removeTechnicalTables([inv.journal]);
}

// Supprimer un export : ses destinataires sont coupés, ses lignes Synchro effacées (la table
// disparaît avec le dernier export), avec le journal de retour d'un Échange. Les colonnes id_sync
// et MajLe restent dans les tables.
export const endExport = exp => closeExport(exp.id, { keepExport: false });

// ---------------------------------------------------------------------------------------------
// Lien public : pas de webhook, la CIBLE lit elle-même les instantanés de l'export.

// `version` : la version de l'application qui fait le code (elle y est écrite, voir versionNote).
export async function publicCode(exp, version) {
  const identity = await docIdentity();
  const { origin, baseUrl } = identity;
  return buildInvitation({ id: exp.id, exportId: exp.id, name: exp.name, origin, base: baseUrl, from: await sourceFrom(exp.email, identity), tables: exp.tables, version });
}

// Couper le lien public d'un export : ses instantanés disparaissent, les règles d'accès suivent au
// prochain affichage. Tant que le document reste public, le refus général reste en place.
export async function stopPublicShare(exp) {
  await updateSourceNote(note => setExport(note, exp.id, { public: false }));
  await saveExport(exp.id, exp.tables, { isPublic: false });
}
