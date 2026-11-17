// SOURCE : ce que l'onglet Envoyer dit d'un envoi. Où il en est (lignes, lots, temps restant), ce
// qu'il attend (budget, autre page, rattrapage), pourquoi il ne bouge pas (destinataire en erreur,
// tout en pause), et ce qu'un envoi va coûter avant de le lancer.
import { LONG_SECONDS, durationParts, sizeParts } from '../engine/logic/estimate.js';
import { BUDGET_WINDOW, RESEND_BUDGET } from '../engine/logic/resend.js';
import { el, openModal } from '../ui.js';
import { t, timeText } from '../i18n.js';

function durationText(seconds) {
  const { h, min } = durationParts(seconds);
  if (!h && !min) return t('common.dur.under');
  if (!h) return t('common.dur.min', { n: min });
  return min ? t('common.dur.hm', { h, m: min }) : t('common.dur.h', { h });
}

function sizeText(bytes) {
  const { n, unit } = sizeParts(bytes);
  return t(`common.size.${unit}`, { n });
}

// ---------------------------------------------------------------------------------------------
// Avancement d'un export (voir exportFlow)

const TONE = { blocked: 'err', paused: 'warn', interrupted: 'warn' };
const MOVING = ['running', 'runningOther', 'budget'];

// Le message d'un état d'envoi, avec sa barre d'avancement quand le total est connu. Sans rôle
// d'alerte : il se met à jour de lui-même, un lecteur d'écran ne doit pas le répéter à chaque lot.
export function flowView(flow) {
  if (!flow) return null;
  const v = flow.vars;
  const parts = [t(`send.flow.${flow.key}`, { ...v, at: v.at ? timeText(v.at) : '' })];
  if (v.left && MOVING.includes(flow.key)) parts.push(t('send.flow.left', { left: durationText(v.left) }));
  if (flow.key === 'waiting' && v.at) parts.push(t('send.flow.lastPass', { at: timeText(v.at) }));
  const box = el('div', { class: 'flow', 'data-flow': flow.key },
    el('p', { class: `msg msg-${TONE[flow.key] || 'info'}`, role: TONE[flow.key] === 'err' ? 'alert' : null }, parts.join(' ')));
  if (v.total && MOVING.includes(flow.key)) box.append(el('progress', { max: v.total, value: Math.min(v.done, v.total), 'aria-label': t('send.flow.bar', { pct: v.pct }) }));
  return box;
}

// Dessine dans `out` l'avancement que le moteur donne à chaque tranche d'un renvoi (resendTables), et
// l'efface quand il rend `null`. Sans `out`, rien n'est dessiné.
export const progressTo = out => out && ((flow) => {
  if (flow === null) {
    out.replaceChildren();
    return;
  }
  out.replaceChildren(flowView(flow));
  out.scrollIntoView({ block: 'nearest' });
});

// ---------------------------------------------------------------------------------------------
// Estimation avant un envoi complet (le calcul est dans le moteur : engine/source/estimate.js)

// Lignes de texte qui disent ce que l'envoi va coûter et pourquoi il ne part pas d'un coup.
export function estimateLines(est) {
  return [
    el('p', {}, t('send.estimate.body', {
      rows: est.rows, size: sizeText(est.bytes), lots: est.lots, n: est.recipients, dur: durationText(est.seconds),
    })),
    est.seconds >= LONG_SECONDS ? el('p', { class: 'muted small' }, t('send.estimate.pace', { mb: RESEND_BUDGET / 1000000, min: BUDGET_WINDOW / 60 })) : null,
  ];
}

// Confirmation d'un envoi long : le coût d'abord, puis Envoyer ou Annuler. Vrai si la personne envoie.
export function confirmSend(est) {
  return new Promise((resolve) => {
    let answered = false;
    openModal({
      title: t('send.estimate.title'), body: estimateLines(est), width: 480,
      onClose: () => { if (!answered) resolve(false); },
      buttons: [
        { label: t('common.cancel'), onClick: (m) => { answered = true; resolve(false); m.close(); } },
        { label: t('send.load.ok'), kind: 'btn-primary', onClick: (m) => { answered = true; resolve(true); m.close(); } },
      ],
    });
  });
}
