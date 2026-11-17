// SOURCE : actions sur un export et ses destinataires, depuis sa carte : la confirmation et les fenêtres
// sont ici, ce que l'action fait est dans le moteur (engine/source/actions.js).
import { VERSION } from '../config.js';
import {
  cancelPendingInvitation, pauseRecipient, publicCode as makePublicCode, endExport, resumePlan, resumeRecipient, revokeRecipient, revokesOne, stopPublicShare,
} from '../engine/source/actions.js';
import { clearAndMark } from '../engine/source/resend.js';
import { clearExportHistory } from '../engine/source/history.js';
import { updateSourceNote } from '../engine/source/synchro.js';
import { markStay } from './public-stay.js';
import { hookShown } from './shown.js';
import { progressTo } from './flow.js';
import { closeButtons, confirmDialog, copyField, el, openModal } from '../ui.js';
import { handoffButton } from '../guide.js';
import { t } from '../i18n.js';

// Mise en pause du destinataire `h` de l'export `exp` (voir engine/source/pausing.js).
export const pause = pauseRecipient;

// Choix de reprise : rattraper (par défaut) ou reprendre tel quel. Rend 'catchup', 'as-is' ou null.
function resumeChoice(title, help) {
  const choice = (value, label, text, checked) => [el('label', { class: 'check' },
    el('input', { type: 'radio', name: 'gristsync-resume', value, checked }), el('strong', {}, label)), el('p', { class: 'muted small choice-help' }, text)];
  const body = el('div', { class: 'form', role: 'radiogroup', 'aria-label': title },
    choice('catchup', t('send.resume.catchup'), help, true), choice('as-is', t('send.resume.asIs'), t('send.resume.asIs.help'), false));
  return new Promise((resolve) => {
    let answered = false;
    const done = (m, value) => { answered = true; resolve(value); m.close(); };
    openModal({
      title, body,
      onClose: () => { if (!answered) resolve(null); },
      buttons: [{ label: t('common.cancel'), onClick: m => done(m, null) },
        { label: t('send.action.resume'), kind: 'btn-primary', onClick: m => done(m, body.querySelector('input:checked').value) }],
    });
  });
}

// Reprendre après une pause (voir resumePlan pour le rattrapage proposé).
export async function resume(exp, h, out) {
  const { since, n, all } = await resumePlan(exp, h);
  const help = [t('send.resume.catchup.help', { n }), all ? t('send.resume.all') : ''].filter(Boolean).join(' ');
  const picked = await resumeChoice(t('send.resume.title', { name: hookShown(h.fields.memo) || exp.name }), help);
  if (!picked) return;
  await resumeRecipient(exp, h, { catchup: picked === 'catchup', since }, progressTo(out));
}

// Révoquer une personne (voir revokeRecipient).
export async function revoke(exp, h) {
  const one = revokesOne(exp);
  const body = t(one ? 'send.revoke.participant' : exp.echange ? 'send.revoke.exchange' : 'send.revoke.body');
  if (!(await confirmDialog({ title: t('send.revoke.title', { name: h.fields.memo || exp.name }), body, confirmLabel: t('send.action.revoke') }))) return;
  await revokeRecipient(exp, h);
}

// Annuler une invitation ; celle d'un Échange emporte son journal de retour.
export async function cancelInvitation(inv) {
  if (!(await confirmDialog({ title: t('send.cancel.title'), body: t('send.cancel.body'), confirmLabel: t('send.action.cancel') }))) return;
  await cancelPendingInvitation(inv);
}

// Débloquer : la file de Grist est commune au document, la vider abandonne les envois en attente
// de tous les destinataires ; le rattrapage renvoie ensuite les exports servis.
export async function unblockQueue() {
  if (await confirmDialog({ title: t('send.unblock.title'), body: t('send.unblock.body'), confirmLabel: t('send.action.unblock') })) await clearAndMark();
}

// Supprimer un export : ses destinataires sont coupés (voir endExport).
export async function deleteExport(exp) {
  const body = t('send.delete.body', { n: exp.recipients.length });
  if (!(await confirmDialog({ title: t('send.delete.title', { name: exp.name }), body, confirmLabel: t('send.action.delete') }))) return;
  await endExport(exp);
  if (exp.public) await rememberStay(); // le partage public de Grist, lui, reste ouvert (voir public-stay.js)
}

// Effacer l'historique des envois d'un export (et, en Échange, l'avant et les lignes supprimées de ses journaux de retour) :
// sur demande seulement, après confirmation (voir engine/source/history.js).
export async function clearHistory(exp) {
  const body = [el('p', {}, t('send.history.clearBody')), exp.echange && !exp.retour ? el('p', {}, t('send.history.clearBack')) : null, el('p', { class: 'muted small' }, t('send.history.clearLimits'))];
  if (!(await confirmDialog({ title: t('send.history.clearTitle', { name: exp.name }), body, confirmLabel: t('send.history.clear') }))) return;
  await clearExportHistory(exp.id);
}

// ---------------------------------------------------------------------------------------------
// Lien public : pas de webhook, la CIBLE lit elle-même les instantanés de l'export.

export const publicCode = exp => makePublicCode(exp, VERSION);

export async function showPublicCode(exp) {
  const code = await publicCode(exp);
  await new Promise(resolve => openModal({ title: exp.name, onClose: resolve,
    body: [el('p', {}, t('send.public.help')), copyField(code), handoffButton('target', 'public', 1, code)], buttons: closeButtons() }));
}

// Couper le lien public d'un export (voir stopPublicShare).
export async function stopPublic(exp) {
  const body = t('send.public.revokeBody');
  if (!(await confirmDialog({ title: t('send.public.stopTitle', { name: exp.name }), body, confirmLabel: t('send.public.stop') }))) return;
  await stopPublicShare(exp);
  await rememberStay();
}

// Couper un lien public ou supprimer un export public retire l'export du widget, pas le partage public de Grist : la note le
// retient, l'onglet le dit tant que Grist montre le document public (voir public-stay.js). Sans note (la table Synchro part avec
// le dernier export), rien à retenir ; un échec ne fait jamais échouer l'action déjà faite.
const rememberStay = () => updateSourceNote(markStay).catch(console.warn);
