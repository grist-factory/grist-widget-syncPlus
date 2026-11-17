// Démarrage : thème et langue, chargement de l'API des widgets depuis l'instance Grist, choix de
// l'onglet, Réglages.
import { GRIST_ORIGINS, VERSION, widgetUrl } from './config.js';
import { LANG, t, translatePage } from './i18n.js';
import { applyTheme, readPref, wizardAsked, writePref } from './prefs.js';
import { sleep } from './engine/logic/common.js';
import { ownsSync } from './engine/logic/strays.js';
import { isReadOnly, readSchema } from './grist.js';
import { readSourceNote } from './engine/source/synchro.js';
import { receivedJournals } from './engine/logic/received.js';
import { readLost } from './engine/target/lost.js';
import { copyField, el, errorText, icon, message, noteError, openModal, unreachable } from './ui.js';
import { startOfferNotice } from './tab-link-ui.js';
import { diagnostic } from './diagnostic.js';
import { roleGuide } from './guide.js';
import { accessHelp, tutorialView } from './tutorial.js';
import { isOwnerHere, lostSynchro, reinforceFacts, refreshSource, renderSource } from './source/tab.js';
import { startAutoCatchUp } from './engine/source/resend.js';
import { receiveOffered, refreshTarget, reinforceReceptions, renderTarget } from './target/tab.js';
import { newsSeen, openNews } from './news.js';
import { consolidateAll, startAutoConsolidation } from './engine/target/loop.js';
import { startEngine } from './engine/index.js';
import { syncPort } from './sync-port.js';

const $ = id => document.getElementById(id);
const RETRY_MS = 3000; // Grist injoignable un instant : nouvel essai de l'onglet
const START_MS = 15000; // au démarrage, au-delà : Grist est injoignable

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

// Démarrage impossible : ce qu'il faut faire, le réglage d'accès à montrer en images, l'adresse du
// widget (hors de Grist) ou un bouton pour recharger. Les onglets restent visibles, grisés.
function showStartProblem(text, { withAddress = false, reload = false, access = false } = {}) {
  for (const button of document.querySelectorAll('[data-tab]')) button.disabled = true;
  showScreen(message('warn', text), access ? accessHelp() : null, withAddress ? copyField(widgetUrl()) : null,
    reload ? el('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, t('start.reload')) : null);
}

async function select(tab, retry = true) {
  for (const button of document.querySelectorAll('[data-tab]')) button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  const view = el('div', { class: 'view' });
  showScreen(view);
  if (tab === 'help') return view.append(tutorialView(el('div', { class: 'form' }, el('p', { class: 'small' }, t('guide.install')), copyField(widgetUrl()))));
  try {
    await (tab === 'send' ? renderSource(view) : renderTarget(view));
  } catch (e) {
    // Grist injoignable un instant : un nouvel essai, puis le message ; la console n'en garde que
    // la trace.
    if (!unreachable(e)) console.error(e);
    else console.warn(e);
    noteError(e);
    if (unreachable(e) && retry) {
      await sleep(RETRY_MS);
      return view.isConnected ? select(tab, false) : undefined;
    }
    view.replaceChildren(message('err', errorText(e)));
  }
  return undefined;
}

function showHome(notOwner = false) {
  for (const button of document.querySelectorAll('[data-tab]')) button.setAttribute('aria-selected', 'false');
  const tile = (tab, title, desc) => el('button', { class: 'tile', type: 'button', onclick: () => select(tab) },
    el('span', { class: 'tile-title' }, title), el('span', { class: 'tile-desc' }, desc));
  showScreen(el('h2', { class: 'home-title' }, t('home.title')),
    notOwner ? message('info', t('home.notOwner')) : null,
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
      diagnosticBlock(),
      el('h3', {}, t('settings.credits')),
      el('dl', { class: 'fiche small' }, credits.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]))),
  });
}

// Diagnostic à copier (voir diagnostic.js) : relu à l'ouverture des Réglages, visible avant d'être
// copié. Copie refusée par le navigateur : le texte s'ouvre, sélectionné.
function diagnosticBlock() {
  const area = el('textarea', { class: 'code', readonly: true, rows: 8, spellcheck: 'false', 'aria-label': t('settings.diag') });
  const shown = el('details', {}, el('summary', { class: 'small' }, t('settings.diag.show')), area);
  const out = el('div', { class: 'out' });
  const text = diagnostic().catch((e) => { out.append(message('err', errorText(e))); return ''; });
  text.then((value) => { area.value = value; });
  const copy = el('button', { class: 'btn', type: 'button', onclick: async () => {
    const value = await text;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      copy.lastChild.textContent = t('common.copied');
      setTimeout(() => { copy.lastChild.textContent = t('settings.diag.copy'); }, 1500);
    } catch (e) {
      shown.open = true;
      area.select();
    }
  } }, icon('copy'), t('settings.diag.copy'));
  return [el('h3', {}, t('settings.diag')), el('p', { class: 'muted small' }, t('settings.diag.help')), copy, out, shown];
}

async function start() {
  startEngine({ port: syncPort, version: VERSION }); // le moteur parle à Grist par ce port (js/sync-port.js), noms de tables d'avant
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
    await Promise.race([grist.docApi.fetchTable('_grist_Tables'), sleep(START_MS).then(() => { throw new Error('timeout'); })]);
  } catch (e) {
    return showStartProblem(t(e.message === 'timeout' ? 'start.slow' : 'start.access'), { reload: true, access: true });
  }

  startAutoConsolidation(refreshTarget);
  startAutoCatchUp(refreshSource);
  startOfferNotice($('offer'), useOffer);
  try {
    await openFirstScreen();
  } catch (e) {
    // Document illisible juste après la sonde (rechargé par Grist, réseau) : rien ne s'affiche
    // sinon. L'erreur est montrée, la console n'en garde que la trace.
    console.warn(e);
    showStartProblem(t('start.failed', { detail: errorText(e) }), { reload: true });
  }
}

// Une invitation arrivée d'un autre onglet du navigateur (tab-link.js) : l'onglet Recevoir, puis l'assistant sur son
// code. Rend faux, sans rien ouvrir, quand un assistant l'est déjà (l'avis reste affiché).
async function useOffer(code) {
  await select('receive');
  if (document.querySelector('.scrim')) return false;
  receiveOffered(code);
  return true;
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
  else if (wizardAsked('reception')) await select('receive'); // « Accepter une invitation » demandé juste avant le rechargement des règles
  else if (wizardAsked('export') && ownsSync(schema)) await select('send'); // « Nouvel export » demandé juste avant le rechargement des règles
  else if (!backLink && journals.some(r => !r.note.retour)) await select('receive');
  // Une table Synchro sans export (posée par protectSync, puis l'assistant fermé) ne dit pas que ce document envoie : l'accueil.
  else if ((ownsSync(schema) && readSourceNote(schema).exports.length) || await lostSynchro(schema)) await select('send');
  else if ((await readLost()).length) await select('receive');
  else showHome(await isOwnerHere() === false);
  if (journals.length) consolidateAll();
  await showNews(schema, journals);
}

// Les nouveautés, une fois par version : seulement dans un document déjà installé (reçoit ou envoie), jamais pendant un
// assistant ni sans pouvoir écrire (un lecteur ne renforce rien).
async function showNews(schema, journals) {
  const installed = journals.length || (ownsSync(schema) && readSourceNote(schema).exports.length);
  if (!installed || newsSeen() || document.querySelector('.scrim') || isReadOnly()) return;
  const [source, receptions] = await Promise.all([reinforceFacts().catch(() => ({})), reinforceReceptions().catch(() => 0)]);
  if (document.querySelector('.scrim')) return;
  openNews({ facts: { exports: 0, people: 0, invitations: 0, ...source, receptions }, onGo: tab => select(tab) });
}

start();
