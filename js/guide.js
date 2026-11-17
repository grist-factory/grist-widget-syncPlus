// Mode d'emploi à deux rôles : qui fait quoi, dans quel document. Affiché sur l'accueil et en bas
// des assistants, pour que chacun sache ce qu'il fait et ce que l'autre document doit faire, et
// texte de consignes à transmettre avec un code.
import { widgetUrl } from './config.js';
import { t } from './i18n.js';
import { copyButton, copyField, el } from './ui.js';

// Étapes de chaque mode, dans l'ordre : [rôle, clé du texte].
const STEPS = {
  reponse: [['source', 'guide.s1'], ['target', 'guide.t1'], ['target', 'guide.t2'], ['source', 'guide.s2'], ['target', 'guide.t3']],
  public: [['source', 'guide.p.s1'], ['target', 'guide.p.t1']],
  echange: [['source', 'guide.e.s1'], ['target', 'guide.e.t1'], ['target', 'guide.t2'], ['source', 'guide.s2'], ['target', 'guide.e.t3']],
};

// `you` : rôle de ce document ('source', 'target' ou null sur l'accueil). `current` : étape en
// cours ou attendue (-1 : aucune). Replié par défaut dans les assistants.
export function roleGuide({ you = null, mode = 'reponse', current = -1, open = false }) {
  const steps = STEPS[mode].map(([role, key], i) => el('li', { class: i === current ? 'current' : null },
    el('span', { class: `role-badge role-${role}` }, t(`guide.role.${role}`) + (role === you ? ` · ${t('guide.you')}` : '')),
    el('span', {}, t(key))));
  return el('details', { class: 'guide', open },
    el('summary', {}, t('guide.title')),
    el('ol', { class: 'guide-steps' }, steps),
    mode === 'public' ? null : el('p', { class: 'muted small' }, t('guide.publicNote')),
    el('p', { class: 'small' }, t('guide.install')), copyField(widgetUrl()));
}

// Bouton « Copier avec les consignes » : le code et les étapes de l'autre document (`role`, à partir
// de l'étape `from`), prêts pour un courriel.
export const handoffButton = (role, mode, from, code) => el('div', { class: 'handoff' },
  copyButton(() => handoffText(role, mode, from, code), t('guide.copyHandoff')), el('span', { class: 'muted small' }, t('guide.copyHandoff.help')));

// Consignes pour l'autre document (`role`), ses étapes à partir de `from`, à coller dans un
// courriel avec le code.
function handoffText(role, mode, from, code) {
  const lines = STEPS[mode].slice(from).filter(([r]) => r === role).map(([, key], i) => `${i + 1}. ${t(key)}`);
  return [t(`guide.handoff.${role}`), '', ...lines, '', t('guide.install'), widgetUrl(), '', t('guide.handoff.code'), code].join('\n');
}
