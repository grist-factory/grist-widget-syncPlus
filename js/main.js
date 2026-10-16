// Démarrage : thème et langue, chargement de l'API des widgets depuis l'instance Grist, choix de
// l'onglet, Réglages.
import { GRIST_ORIGINS, VERSION } from './config.js';
import { LANG, t, translatePage } from './i18n.js';
import { applyTheme, readPref, writePref } from './prefs.js';
import { SYNC_TABLE } from './logic/common.js';
import { readSchema } from './grist.js';
import { legacyTables, readSourceNote } from './source/synchro.js';
import { legacyJournals, receivedJournals } from './target/journals.js';
import { copyField, el, errorText, message, openModal } from './ui.js';
import { roleGuide, widgetAddress } from './guide.js';
import { tutorialView } from './tutorial.js';
import { refreshSource, renderSource } from './source/tab.js';
import { startAutoCatchUp } from './source/resend.js';
import { refreshTarget, renderTarget } from './target/tab.js';
import { consolidateAll, startAutoConsolidation } from './target/loop.js';

const $ = id => document.getElementById(id);

// L'API des widgets vient de l'instance qui affiche le widget, si elle est dans la liste ; sinon
// de la première instance de la liste. Jamais d'une adresse choisie par la page qui encadre.
function loadPluginApi() {
  let origin = GRIST_ORIGINS[0];
  try {
    const parent = new URL(document.referrer).origin;
    if (GRIST_ORIGINS.includes(parent)) origin = parent;
  } catch (e) { /* pas de référent : instance par défaut */ }
  return new Promise((resolve, reject) => {
    const script = el('script', { src: `${origin}/grist-plugin-api.js` });
    script.onload = resolve;
    script.onerror = () => reject(new Error(origin));
    document.head.append(script);
  });
}

function showScreen(...nodes) {
  $('main').replaceChildren(...nodes.filter(Boolean));
}

// Démarrage impossible : ce qu'il faut faire, l'adresse du widget (hors de Grist) ou un bouton
// pour recharger. Les onglets restent visibles, grisés.
function showStartProblem(text, { withAddress = false, reload = false } = {}) {
  for (const button of document.querySelectorAll('[data-tab]')) button.disabled = true;
  showScreen(message('warn', text), withAddress ? copyField(widgetAddress()) : null,
    reload ? el('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, t('start.reload')) : null);
}

async function select(tab) {
  for (const button of document.querySelectorAll('[data-tab]')) button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  const view = el('div', { class: 'view' });
  showScreen(view);
  if (tab === 'help') return view.append(tutorialView(el('div', { class: 'form' }, el('p', { class: 'small' }, t('guide.install')), copyField(widgetAddress()))));
  try {
    await (tab === 'send' ? renderSource(view) : renderTarget(view));
  } catch (e) {
    console.error(e);
    view.replaceChildren(message('err', errorText(e)));
  }
  return undefined;
}

function showHome() {
  for (const button of document.querySelectorAll('[data-tab]')) button.setAttribute('aria-selected', 'false');
  const tile = (tab, title, desc) => el('button', { class: 'tile', type: 'button', onclick: () => select(tab) },
    el('span', { class: 'tile-title' }, title), el('span', { class: 'tile-desc' }, desc));
  showScreen(el('h2', { class: 'home-title' }, t('home.title')),
    el('div', { class: 'tiles' }, tile('send', t('home.send'), t('home.send.desc')), tile('receive', t('home.receive'), t('home.receive.desc'))),
    roleGuide({}));
}

function openSettings() {
  const radios = (name, title, values, current, onPick) => el('div', { class: 'radios', role: 'radiogroup', 'aria-label': title }, values.map(([value, label]) =>
    el('label', {}, el('input', { type: 'radio', name, value, checked: value === current, onchange: e => onPick(value, e.target) }), label)));
  const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
  const credits = [
    [t('settings.credits.author'), 'Grist Factory'],
    [t('settings.credits.site'), link('https://grist-factory.fr', 'grist-factory.fr')],
    [t('settings.credits.license'), link('https://www.gnu.org/licenses/gpl-3.0.html', 'GNU GPL v3.0')],
    [t('settings.credits.version'), VERSION],
  ];
  openModal({
    title: t('settings.title'), width: 400,
    body: el('div', { class: 'form' },
      el('h3', {}, t('settings.lang')),
      // Langue non retenue (stockage refusé) : le choix revient à la langue en cours.
      radios('lang', t('settings.lang'), [['fr', 'Français'], ['en', 'English']], LANG, (lang, input) => {
        if (writePref('lang', lang)) location.reload();
        else { input.checked = false; document.querySelector(`input[name="lang"][value="${LANG}"]`).checked = true; }
      }),
      el('h3', {}, t('settings.theme')),
      radios('theme', t('settings.theme'), [['system', t('settings.theme.system')], ['light', t('settings.theme.light')], ['dark', t('settings.theme.dark')]],
        readPref('theme') || 'system', (theme) => { writePref('theme', theme); applyTheme(); }),
      el('h3', {}, t('settings.credits')),
      el('dl', { class: 'fiche small' }, credits.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]))),
  });
}

async function start() {
  applyTheme();
  translatePage();
  $('settings').addEventListener('click', openSettings);
  for (const button of document.querySelectorAll('[data-tab]')) {
    button.addEventListener('click', () => { picked = button.dataset.tab; if (ready) select(picked); });
  }

  if (window.parent === window) return showStartProblem(t('start.outside'), { withAddress: true });
  try {
    await loadPluginApi();
  } catch (e) {
    return showStartProblem(t('start.network', { origin: e.message }), { reload: true });
  }
  grist.ready({ requiredAccess: 'full' });
  // Sans accès complet, Grist refuse la lecture ; sans réponse du tout, Grist est injoignable.
  try {
    await Promise.race([grist.docApi.fetchTable('_grist_Tables'), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))]);
  } catch (e) {
    return e.message === 'timeout' ? showStartProblem(t('start.slow'), { reload: true }) : showStartProblem(t('start.access'));
  }

  startAutoConsolidation(refreshTarget);
  startAutoCatchUp(refreshSource);
  try {
    await openFirstScreen();
  } catch (e) {
    // Document illisible juste après la sonde (rechargé par Grist, réseau) : rien ne s'affiche
    // sinon. L'erreur est montrée, la console n'en garde que la trace.
    console.warn(e);
    showStartProblem(t('start.failed', { detail: errorText(e) }), { reload: true });
  }
}

// Onglet choisi pendant le démarrage : il est ouvert à la place du premier écran (vu au test : le
// premier écran, choisi plus tard, l'écrasait).
let picked = null;
let ready = false;

// Premier écran : l'onglet choisi, sinon celui du rôle que le document tient déjà, sinon l'accueil.
async function openFirstScreen() {
  const schema = await readSchema();
  const journals = receivedJournals(schema);
  // Échange dont le formulaire de retour vient d'être publié : l'assistant reprend dans Envoyer.
  // Le journal de retour d'un Échange fait partie de l'envoi : il n'ouvre pas Recevoir.
  const backLink = readSourceNote(schema).invitations.some(inv => inv.journal && !inv.ready);
  ready = true;
  if (picked) await select(picked);
  else if (!backLink && (journals.some(r => !r.note.retour) || legacyJournals(schema).length)) await select('receive');
  else if (schema.has(SYNC_TABLE) || legacyTables(schema).length) await select('send');
  else showHome();
  if (journals.length) consolidateAll();
}

start();
