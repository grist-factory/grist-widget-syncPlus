// Fenêtre des nouveautés : une fois par version et par navigateur, à l'ouverture d'un document déjà installé (la personne
// qui monte son premier partage n'a rien à rattraper). Deux écrans : les nouveautés, puis « Vos partages » (ce qui se
// renforce dans ce document, sans rien imposer). Rien n'est écrit dans le document ; seule la version vue est gardée dans
// les préférences du navigateur (`news`).
import { readPref, writePref } from './prefs.js';
import { backButton, el, laterButton, message, openWizard } from './ui.js';
import { t } from './i18n.js';

export const NEWS_VERSION = '0.21';
const POINTS = ['echange', 'files', 'filter', 'signed', 'taken', 'follow', 'sends', 'errors', 'setup'];

export const newsSeen = () => readPref('news') === NEWS_VERSION;
export const markNewsSeen = () => writePref('news', NEWS_VERSION);

// `facts` : { exports, people, invitations, receptions } (voir newsFacts) ; `onGo(tab)` : ouvre l'onglet où se renforce un partage.
export function openNews({ facts, onGo, onClose }) {
  const steps = [t('news.step.news'), t('news.step.shares')];
  // Vue seulement quand la fenêtre se ferme : si Grist recharge le document au même moment (règles d'accès posées au premier
  // affichage d'un partage monté depuis une version d'avant), la fenêtre disparaît avec la page et revient au chargement suivant.
  const wizard = openWizard({ title: t('news.title'), steps, onClose: () => { markNewsSeen(); if (onClose) onClose(); } });
  wizard.start(() => showNews(wizard, facts, onGo));
  return wizard;
}

function showNews(wizard, facts, onGo) {
  const detail = el('p', { class: 'msg msg-info', role: 'status' }, t(`news.${POINTS[0]}.line`));
  const buttons = POINTS.map((point, i) => el('button', {
    class: 'btn', type: 'button', 'aria-pressed': String(i === 0), 'data-news': point,
    onclick: () => {
      for (const other of buttons) other.setAttribute('aria-pressed', String(other === buttons[i]));
      detail.textContent = t(`news.${point}.line`);
    },
  }, t(`news.${point}.title`)));
  wizard.show(0, [el('p', {}, t('news.intro')), el('div', { class: 'tuto-filter', role: 'group', 'aria-label': t('news.step.news') }, buttons), detail],
    [laterButton(), { label: t('common.next'), kind: 'btn-primary', onClick: () => showShares(wizard, facts, onGo) }]);
}

// Ce que ce document peut renforcer : en chiffres quand il y en a, sinon une phrase qui rassure.
function factsLine(facts) {
  const parts = [];
  if (facts.exports) parts.push(t('news.facts.exports', { n: facts.exports }));
  if (facts.people) parts.push(t('news.facts.people', { n: facts.people }));
  if (facts.invitations) parts.push(t('news.facts.invitations', { n: facts.invitations }));
  if (facts.receptions) parts.push(t('news.facts.receptions', { n: facts.receptions }));
  return parts.length ? parts.join(' · ') : t('news.facts.none');
}

function showShares(wizard, facts, onGo) {
  const group = (title, lines) => el('div', {}, el('p', { class: 'field-title' }, title), el('ul', {}, lines.map(line => el('li', {}, t(line)))));
  const go = (facts.people || facts.invitations) ? 'send' : facts.receptions ? 'receive' : '';
  wizard.show(1, [
    message('ok', t('news.shares.ok')), el('p', { class: 'small' }, t('news.shares.only')),
    el('details', {}, el('summary', {}, t('news.shares.why')), el('p', { class: 'small' }, t('news.shares.whyBody'))),
    group(t('news.shares.kept'), ['news.kept1', 'news.kept2', 'news.kept3']),
    group(t('news.shares.todo'), ['news.todo1', 'news.todo2', 'news.todo3']),
    el('p', {}, el('strong', {}, t('news.facts.title')), ' ', factsLine(facts)),
    facts.receptions ? el('p', { class: 'small' }, t('news.shares.target', { n: facts.receptions })) : null,
  ], [backButton(() => showNews(wizard, facts, onGo)), laterButton(),
    go ? { label: t('news.shares.go'), kind: 'btn-primary', onClick: (modal) => { modal.close(); onGo(go); } } : { label: t('common.close'), kind: 'btn-primary' }]);
}
