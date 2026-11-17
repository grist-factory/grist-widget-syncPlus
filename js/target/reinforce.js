// CIBLE : « Renforcer la sécurité » d'un partage branché avant les clés de signature. Rien n'est imposé : tant que la
// personne ne fait rien, l'envoi arrive comme avant. Les états viennent de `renfState` (moteur) ; ici, les avis de la
// carte et leurs boutons. Vocabulaire : « renforcer » est une suggestion, jamais un ordre.
import { GRACE_DAYS, graceEnd, renfState } from '../engine/logic/reinforce.js';
import { revertReinforcement } from '../engine/target/receive.js';
import { confirmDialog, notice, run, smallButton } from '../ui.js';
import { dateText, t } from '../i18n.js';
import { receiveWizard } from './wizard.js';

const DONE_SHOWN_S = 30 * 86400; // « Partage renforcé » reste affiché un mois
const nowS = () => Math.floor(Date.now() / 1000);

// L'état à dire sur la carte : 'suggest' (partage sans clé, jamais renforcé), 'pending', 'expired', 'done' (récent), ou ''.
export function reinforceKind(group, now = nowS()) {
  const state = renfState(group.note, now);
  if (state === 'done') return now - group.note.renf.done < DONE_SHOWN_S ? 'done' : '';
  if (state !== 'none') return state;
  return group.unsigned && !group.waiting && !group.public ? 'suggest' : '';
}

// `rerender` : redessin de l'onglet ; `out` : où montrer l'erreur d'un bouton.
export function reinforceNotes(group, { rerender, out, readOnly = false }) {
  const kind = reinforceKind(group);
  const end = dateText(graceEnd(group.note) * 1000);
  const start = () => receiveWizard(null, rerender);
  const again = () => receiveWizard(group, rerender);
  const revert = async (event) => {
    const ok = await confirmDialog({ title: t('recv.renf.revert.title'), body: t('recv.renf.revert.body'), confirmLabel: t('recv.renf.revert'), kind: 'btn-primary' });
    if (!ok) return;
    await run(event.currentTarget, out(), async () => { await revertReinforcement(group.journal); await rerender(); });
  };
  const act = (label, onClick, primary = false, icon = 'link') => smallButton(label, icon, onClick, { kind: primary ? 'btn-primary' : '', disabled: readOnly });
  const make = ({ tone, title, lines, actions = [] }) => notice({ tone, title, lines, 'data-renf': kind, actions });
  switch (kind) {
    case 'suggest':
      return make({ tone: 'info', title: t('recv.renf.suggest.title'), lines: [t('recv.renf.suggest.body'), t('recv.renf.suggest.safe')], actions: [act(t('recv.renf.start'), start, true)] });
    case 'pending':
      return make({ tone: 'info', title: t('recv.renf.pending.title'), lines: [t('recv.renf.pending.body', { end, days: GRACE_DAYS }), t('recv.renf.pending.safe')], actions: [act(t('recv.renf.reply'), again), act(t('recv.renf.revert'), revert, false, 'undo')] });
    case 'expired':
      return make({ tone: 'err', title: t('recv.renf.expired.title'), lines: [t('recv.renf.expired.body', { end }), t('recv.renf.expired.how')], actions: [act(t('recv.renf.reply'), again, true), act(t('recv.renf.revert'), revert, false, 'undo')] });
    case 'done':
      return make({ tone: 'info', title: '', lines: [t('recv.renf.done', { at: dateText(group.note.renf.done * 1000) })] });
    default:
      return null;
  }
}
