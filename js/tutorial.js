// Tutoriel intégré : le mode d'emploi pas à pas, avec les captures du test d'intégration
// (docs/images, refaites par `CAPTURES=1 npm run test:e2e`). Affiché en entier dans l'onglet
// Tutoriel, et par morceaux (`stepHelp`) en bas des étapes des assistants.
import { LANG, frenchSpaces, t } from './i18n.js';
import { closeButtons, el, openModal } from './ui.js';
import SECTIONS from '../i18n/tutorial.json' with { type: 'json' };

const IMG = name => (name.startsWith('img/') ? name : `docs/images/${name}.png`);

// Les sections (i18n/tutorial.json : id, role 'source', 'target' ou 'both', title et text en fr et
// en, images) suivent le parcours réel, dans l'ordre où les deux personnes le vivent : chacune est
// aussi reprise seule comme aide d'une étape d'assistant (`stepHelp`), son `id` ne change donc pas.
// Les images sont celles du test d'intégration : une capture qui manque fait échouer `npm test`.

// Texte de la langue en cours ; en français, avec ses espaces insécables (voir i18n.js).
const pick = byLang => (LANG === 'en' ? byLang.en : byLang.fr.map(frenchSpaces));
const pickText = byLang => (LANG === 'en' ? byLang.en : frenchSpaces(byLang.fr));

// Une capture, agrandie au clic dans une fenêtre.
function figure(name) {
  const img = el('img', { src: IMG(name), alt: '', loading: 'lazy' });
  return el('button', { class: 'tuto-shot', type: 'button', 'aria-label': t('tuto.zoom'),
    onclick: () => openModal({ title: t('tuto.zoom'), width: 'full', body: el('img', { class: 'tuto-full', src: IMG(name), alt: '' }),
      buttons: closeButtons() }) }, img);
}

// Les paragraphes « 1. … » qui se suivent forment une vraie liste numérotée (lecteurs d'écran compris).
const NUMBERED = /^\d+\.\s+/;
function paragraphs(list) {
  const nodes = [];
  let steps = null;
  for (const text of list) {
    const mark = NUMBERED.exec(text);
    if (!mark) { steps = null; nodes.push(el('p', {}, text)); continue; }
    if (!steps) { steps = el('ol', { class: 'tuto-steps' }); nodes.push(steps); }
    steps.append(el('li', {}, text.slice(mark[0].length)));
  }
  return nodes;
}

// Une section : son texte, puis (facultatif) `more`, un complément replié, puis ses captures.
function section(s, number) {
  return el('section', { class: 'tuto-section', id: `tuto-${s.id}`, 'data-role': s.role },
    el('h2', {}, number ? `${number}. ` : '', pickText(s.title),
      s.role === 'both' ? null : el('span', { class: `role-badge role-${s.role}` }, t(`guide.role.${s.role}`))),
    paragraphs(pick(s.text)),
    s.more ? el('details', { class: 'guide tuto-more' }, el('summary', {}, pickText(s.more.title)), paragraphs(pick(s.more.text))) : null,
    s.images.length ? el('div', { class: 'tuto-shots' }, s.images.map(figure)) : null);
}

// Onglet Tutoriel : tout le parcours, filtrable par rôle.
export function tutorialView(address) {
  const sections = SECTIONS.map((s, i) => section(s, i + 1));
  const filter = role => {
    for (const node of sections) node.classList.toggle('hidden', role !== 'all' && !['both', role].includes(node.dataset.role));
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.role === role));
  };
  const buttons = [['all', t('tuto.all')], ['source', t('tuto.source')], ['target', t('tuto.target')]].map(([role, label]) =>
    el('button', { class: 'btn btn-small', type: 'button', 'data-role': role, 'aria-pressed': String(role === 'all'), onclick: () => filter(role) }, label));
  return el('div', { class: 'tuto' },
    el('h2', { class: 'home-title' }, t('tuto.title')),
    el('p', { class: 'muted' }, t('tuto.intro')),
    el('div', { class: 'tuto-filter', role: 'group', 'aria-label': t('tuto.filter') }, buttons),
    sections,
    address);
}

// Aide en images pour une étape d'assistant : les sections `ids`, repliées.
export function stepHelp(ids) {
  const chosen = SECTIONS.filter(s => ids.includes(s.id));
  return el('details', { class: 'guide tuto-step' }, el('summary', {}, t('tuto.step')), chosen.map(s => section(s)));
}

// Les trois captures du réglage d'accès de Grist : la page entière, pour voir où est le panneau de droite
// (fermé : l'icône qui l'ouvre ; ouvert : section « Niveau d'accès »).
const ACCESS_SHOTS = [['start.access.open', '00g-installer-acces-ouvrir'], ['start.access.accept', '00e-installer-acces-accepter'], ['start.access.list', '00f-installer-acces-liste']];

// Ce que montre le widget tant qu'il n'a pas l'accès complet : où le régler dans Grist, avec les
// captures (la même aide que l'installation du tutoriel).
export function accessHelp() {
  return el('div', { class: 'access-help' }, el('p', { class: 'small' }, t('start.access.where')),
    el('div', { class: 'access-shots' }, ACCESS_SHOTS.map(([key, name]) => el('figure', { class: 'help-figure' }, el('figcaption', {}, t(key)), figure(name)))));
}
