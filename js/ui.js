// Briques d'interface communes : construction d'éléments sans innerHTML (aucun texte venu du
// document ou d'un code collé n'est interprété comme du HTML), fenêtres, confirmation, champ à
// copier, liste avec recherche.
import { t } from './i18n.js';
import { errorText, failure, known, noteError, recentErrors } from './engine/errors.js';

// Recherche sans accents ni majuscules : chaque mot tapé doit se trouver dans le libellé.
const fold = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const matches = (label, query) => fold(query).split(/\s+/).filter(Boolean).every(w => fold(label).includes(w));

// el('button', {class: 'btn', onclick: fn}, 'Texte') ; les enfants texte passent par textContent,
// les listes d'enfants (imbriquées ou non) sont mises à plat.
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else if (name === 'class') node.className = value;
    else node.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const icon = name => el('span', { class: `icon icon-${name}`, 'aria-hidden': 'true' });

// Lien vers un document Grist, dans un nouvel onglet (`url` : voir docUrl, qui la refait d'après l'instance de
// CE document, jamais d'après un code). Sans adresse sûre, le texte seul. `note` : ce qu'il faut savoir du nom
// montré (vérifié chez Grist, ou dit par l'autre document), dans l'infobulle.
export function docLink(text, url, note = '') {
  if (!url) return text;
  return el('a', { class: 'doc-link', href: url, target: '_blank', rel: 'noopener noreferrer', title: [t('common.docOpen'), note].filter(Boolean).join(' — ') },
    text, icon('external'), el('span', { class: 'sr-only' }, ` ${t('common.newTab')}`));
}

// Pastille d'état d'une carte ou d'une ligne (`tone` : ok, pending, err, off).
export const pill = (text, tone) => el('span', { class: `pill pill-${tone}` }, text);

// Petit bouton d'une carte, avec son icône ; `title` dit pourquoi il est grisé.
export const smallButton = (label, iconName, onclick, { kind = '', disabled = false, title = null } = {}) => el('button', {
  class: `btn btn-small ${kind}`, type: 'button', disabled, title, onclick,
}, icon(iconName), label);

// Avis d'une carte : un seul composant. Le ton dit la gravité : « info » (à savoir), « warn » (à décider ou à
// surveiller), « err » (ne marche plus ; annoncé aux lecteurs d'écran). Un avis qui demande un geste a un
// titre, une ou deux phrases et ses boutons ; une simple information tient en une phrase (`message`).
// `body` : nœuds en plus des phrases (tableau, liste) ; `attrs` : attributs de l'avis (data-…).
export function notice({ tone = 'info', title = '', lines = [], body = [], actions = [], className = '', ...attrs } = {}) {
  return el('div', { class: `msg msg-${tone} notice${className ? ` ${className}` : ''}`, role: tone === 'err' ? 'alert' : 'status', ...attrs },
    title ? el('strong', { class: 'notice-title' }, title) : null,
    lines.filter(Boolean).map(line => el('p', { class: 'small' }, line)),
    body,
    actions.length ? el('div', { class: 'card-actions' }, actions) : null);
}

// Explication d'une option, à la demande : un petit bouton « ? » à côté du libellé montre ou cache le texte juste dessous, sans
// quitter la fenêtre. Le texte reste dans la page (un lecteur d'écran l'atteint dès que le bouton le déplie) ; le bouton annonce
// s'il est ouvert (`aria-expanded`), nomme l'option qu'il explique et se manie au clavier (Entrée, Espace ; Échap le referme sans
// fermer la fenêtre). `text` : une phrase, ou une liste de paragraphes. À réserver aux assistants et fenêtres : l'état ouvert ne
// survit pas à un redessin, et les onglets se redessinent toutes les 10 secondes.
let helpCount = 0;
export function helpButton(text, name) {
  const id = `gristsync-help-${++helpCount}`;
  const panel = el('div', { class: 'help-panel hidden', id, role: 'note' }, [text].flat().map(paragraph => el('p', {}, paragraph)));
  const button = el('button', {
    class: 'help-btn', type: 'button', 'aria-expanded': 'false', 'aria-controls': id,
    'aria-label': t('common.help', { name }), title: t('common.helpShow'),
  }, '?');
  const open = (on) => {
    panel.classList.toggle('hidden', !on);
    button.setAttribute('aria-expanded', String(on));
  };
  button.addEventListener('click', () => open(button.getAttribute('aria-expanded') !== 'true'));
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || button.getAttribute('aria-expanded') !== 'true') return;
    event.stopPropagation(); // la fenêtre reste ouverte : Échap ne ferme que l'explication
    event.preventDefault();
    open(false);
  });
  return { button, panel };
}

// Un contrôle (case, bouton radio, champ avec son libellé) suivi de son « ? » et de son explication.
// `name` : l'option expliquée, pour le lecteur d'écran (par défaut le texte du contrôle, sans compteur).
export function withHelp(control, text, name = '') {
  const { button, panel } = helpButton(text, name || control.textContent.replace(/\s+/g, ' ').trim().slice(0, 90));
  return el('div', { class: 'has-help' }, el('div', { class: 'help-row' }, control, button), panel);
}

// Une phrase, ou un titre et sa phrase quand `title` est donné.
export function message(kind, text, title = '') {
  return title ? notice({ tone: kind, title, lines: [text] }) : el('p', { class: `msg msg-${kind}`, role: kind === 'err' ? 'alert' : 'status' }, text);
}

// ---------------------------------------------------------------------------------------------
// Fenêtres : titre fixe, contenu qui défile, boutons fixes. Le focus entre à l'ouverture,
// tourne dans la fenêtre (Tab), revient à l'élément d'origine à la fermeture ; Échap ferme.

const stack = [];

// Où est le focus clavier dans `root` : bouton, résumé ou lien, avec son nom et son rang parmi ses semblables, pour le
// retrouver quand l'onglet est redessiné (les éléments sont alors tous neufs).
const FOCUS_KINDS = 'button, summary, a[href]';
const focusName = node => node.getAttribute('aria-label') || node.textContent.trim();
const sameKind = (root, tag, name) => [...root.querySelectorAll(tag)].filter(node => focusName(node) === name);
function focusSpot(root, node = document.activeElement) {
  if (!node || node === root || !root.contains(node) || !node.matches(FOCUS_KINDS)) return null;
  const name = focusName(node);
  return { tag: node.tagName, name, index: sameKind(root, node.tagName, name).indexOf(node) };
}
function restoreFocus(root, spot) {
  if (!spot) return false;
  const found = sameKind(root, spot.tag, spot.name);
  const target = found[spot.index] || found[0];
  if (!target || target.disabled) return false;
  target.focus({ preventScroll: true });
  return true;
}
// Redessin automatique d'un onglet (donnée arrivée, passage du rattrapage) : le focus reste sur le même bouton, au lieu de
// tomber en haut de la page pour une personne qui navigue au clavier ou au lecteur d'écran.
export function redraw(root, nodes) {
  const spot = focusSpot(root);
  root.replaceChildren(...nodes);
  restoreFocus(root, spot);
}

export function openModal({ title, body, buttons = [], width = 480, onClose, guard = null }) {
  const opener = document.activeElement;
  const main = document.getElementById('main');
  const spot = main ? focusSpot(main, opener) : null;
  const titleId = `modal-title-${stack.length}`;
  const footer = el('div', { class: 'modal-footer' });
  const closer = el('button', { class: 'modal-x', type: 'button', 'aria-label': t('common.closeWindow'), title: t('common.closeWindow'),
    onclick: () => modal.requestClose() }, el('span', { 'aria-hidden': 'true' }, '×'));
  const frame = el('div', { class: `modal modal-${width}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    el('div', { class: 'modal-head' }, el('h2', { class: 'modal-title', id: titleId }, title), closer),
    el('div', { class: 'modal-body' }, body),
    footer);
  const scrim = el('div', { class: 'scrim' }, frame);
  // Fenêtre de réglages (`guard`) : ce que la personne a touché depuis l'ouverture. Un champ de recherche, une zone de
  // texte (code collé) ou un « ? » ne comptent pas ; `guard.changed()` précise quand on peut comparer à l'état d'ouverture.
  let touched = false;
  const touch = (event) => { if (!(event.target.matches && event.target.matches('input[type="search"], textarea, .help-btn'))) touched = true; };
  if (guard) for (const kind of ['input', 'change', EDITED]) frame.addEventListener(kind, touch);
  const modal = {
    frame, footer,
    isDirty: () => Boolean(guard) && touched && (!guard.changed || guard.changed()),
    clean() { touched = false; },
    touch() { touched = true; },
    // Échap, la croix : quitter tout de suite, ou demander quoi faire des changements non enregistrés.
    async requestClose(result) {
      if (!modal.isDirty()) return modal.close(result);
      const answer = await leaveDialog(Boolean(guard.save));
      if (answer === 'discard') modal.close(result);
      else if (answer === 'save') await guard.save(modal);
    },
    close(result) {
      scrim.remove();
      stack.splice(stack.indexOf(modal), 1);
      if (opener && opener.focus) opener.focus();
      if (onClose) onClose(result);
      // L'onglet se redessine à la fermeture : le bouton d'origine n'existe plus, le focus revient au même bouton du nouveau dessin.
      if (spot) for (const ms of [150, 600, 1500]) setTimeout(() => { if (!stack.length && (!document.activeElement || document.activeElement === document.body)) restoreFocus(main, spot); }, ms);
    },
    // Un clic à la fois : les boutons restent grisés tant que l'action tourne (un double clic
    // brancherait deux fois le même destinataire).
    setButtons(list) {
      footer.replaceChildren(...list.map(b => el('button', {
        class: `btn ${b.kind || ''}${b.back ? ' btn-back' : ''}`, type: 'button', disabled: b.disabled,
        onclick: e => (b.onClick ? busy(e.currentTarget, () => b.onClick(modal)) : modal.close()),
      }, b.label)));
    },
  };
  async function busy(clicked, fn) {
    const all = [...footer.children];
    const before = all.map(button => button.disabled);
    for (const button of all) button.disabled = true;
    try {
      await fn();
    } finally {
      all.forEach((button, i) => { button.disabled = before[i]; });
      if (clicked.isConnected && !frame.contains(document.activeElement)) clicked.focus();
    }
  }
  modal.setButtons(buttons.length ? buttons : [{ label: t('common.close') }]);
  stack.push(modal);
  document.body.append(scrim);
  (frame.querySelector('textarea, input, select, .btn-primary') || footer.querySelector('button')).focus();
  return modal;
}

document.addEventListener('keydown', (event) => {
  const modal = stack[stack.length - 1];
  if (!modal) return;
  if (event.key === 'Escape') { event.preventDefault(); modal.requestClose(false); return; }
  if (event.key !== 'Tab') return;
  const focusable = [...modal.frame.querySelectorAll('button, input, textarea, select, summary, [tabindex="0"]')]
    .filter(n => !n.disabled && n.getClientRects().length);
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  const inside = modal.frame.contains(document.activeElement);
  if (event.shiftKey && (document.activeElement === first || !inside)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || !inside)) { event.preventDefault(); first.focus(); }
});

// Un réglage choisi dans une liste ou une liste de cases (pas des champs natifs, qui disent déjà « change ») prévient la
// fenêtre qui le contient.
const EDITED = 'gristsync-edited';
export const edited = node => node.dispatchEvent(new Event(EDITED, { bubbles: true }));

// « Quitter ? » : ce qu'on demande à qui sort d'une fenêtre de réglages après un changement. Avec `canSave`, trois
// issues (continuer, abandonner, enregistrer) ; sans, deux (rien n'est encore enregistré : une création). Échap revient
// à la fenêtre. Rend 'stay', 'discard' ou 'save'.
function leaveDialog(canSave) {
  return new Promise((resolve) => {
    let answer = 'stay';
    const pick = (value, m) => { answer = value; m.close(); };
    const modal = openModal({
      title: t(canSave ? 'common.leave.title' : 'common.leave.titleNew'), width: 560,
      body: el('p', {}, t(canSave ? 'common.leave.body' : 'common.leave.bodyNew')),
      onClose: () => resolve(answer),
      buttons: [
        { label: t(canSave ? 'common.leave.stay' : 'common.leave.stayNew'), kind: canSave ? '' : 'btn-primary', onClick: m => pick('stay', m) },
        { label: t('common.leave.discard'), kind: 'btn-danger', onClick: m => pick('discard', m) },
        ...(canSave ? [{ label: t('common.save'), kind: 'btn-primary', onClick: m => pick('save', m) }] : []),
      ],
    });
    (modal.footer.querySelector('.btn-primary') || modal.footer.querySelector('button')).focus();
  });
}

// Assistant : une seule fenêtre, des étapes numérotées qui se débloquent l'une après l'autre.
// `show(index, body, buttons)` affiche une étape ; les précédentes sont marquées faites.
// `buttons(list)` change les boutons seuls ; `setSteps(labels)` raccourcit le parcours (lien public).
export function openWizard({ title, steps, onClose, guard = null }) {
  const stepList = el('ol', { class: 'steps' });
  const content = el('div', { class: 'form' });
  // `onClose` ne reçoit rien : Échap ferme avec `false`, qui ne doit pas arriver aux fonctions de
  // dessin (`renderSource(root = container)` dessinerait dans `false`).
  const modal = openModal({ title, body: [stepList, content], onClose: () => onClose && onClose(), width: 720, guard });
  let shown = -1;
  return {
    close: () => modal.close(),
    clean: () => modal.clean(),
    touch: () => modal.touch(),
    buttons: list => modal.setButtons(list),
    setSteps(labels) { steps = labels; },
    show(index, body, buttons) {
      stepList.replaceChildren(...steps.map((label, i) => el('li', {
        class: i < index ? 'done' : i === index ? 'current' : 'locked', 'aria-current': i === index ? 'step' : null,
      }, el('span', { class: 'step-num', 'aria-hidden': 'true' }, i < index ? icon('check') : String(i + 1)), label)));
      content.replaceChildren(...[body].flat().filter(Boolean));
      modal.setButtons(buttons);
      if (index === shown) return; // même étape redessinée : le focus reste où il est
      shown = index;
      const first = content.querySelector('textarea:not([readonly]), input') || modal.footer.querySelector('.btn-primary');
      if (first) first.focus();
    },
    // Première étape (`fn`) : une erreur (lecture refusée, réseau) s'affiche dans la fenêtre, avec
    // Fermer, au lieu de laisser une fenêtre vide.
    async start(fn) {
      const report = el('div', { class: 'report' });
      if ((await run(null, report, async () => { await fn(); return true; })) === undefined) {
        content.replaceChildren(report);
        modal.setButtons(closeButtons());
      }
    },
  };
}

// Boutons des assistants : Annuler, Plus tard (ferment la fenêtre), Retour (`onClick`), Fermer.
export const cancelButton = () => ({ label: t('common.cancel') });
export const laterButton = () => ({ label: t('common.later') });
export const backButton = onClick => ({ label: t('common.back'), back: true, onClick });
export const closeButtons = () => [{ label: t('common.close'), kind: 'btn-primary' }];

// Confirmation d'une action destructrice : promesse d'un booléen, focus sur Annuler.
export function confirmDialog({ title, body, confirmLabel, kind = 'btn-danger' }) {
  return new Promise((resolve) => {
    let answered = false;
    const modal = openModal({
      title, body: typeof body === 'string' ? el('p', {}, body) : el('div', {}, body), width: 400,
      onClose: () => { if (!answered) resolve(false); },
      buttons: [
        { label: t('common.cancel'), onClick: m => { answered = true; resolve(false); m.close(); } },
        { label: confirmLabel, kind, onClick: m => { answered = true; resolve(true); m.close(); } },
      ],
    });
    modal.footer.querySelector('button').focus();
  });
}

// Code en lecture seule avec bouton « Copier ».
export function copyField(value, label = t('common.code')) {
  const area = el('textarea', { class: 'code', readonly: true, rows: 3, spellcheck: 'false', 'aria-label': label });
  area.value = value;
  return el('div', { class: 'copy-field' }, area, copyButton(() => value, t('common.copy'), () => area.select()));
}

// Code d'invitation ou de réponse : il vaut un mot de passe, on le dit sous le bouton Copier.
export const codeField = value => el('div', {}, copyField(value), el('p', { class: 'muted small' }, t('common.codeSecret')));

// Version du widget de l'autre document, lue dans son code (vide : d'avant la 0.12), dite si elle
// n'est pas celle d'ici (`mine`).
export const versionNote = (theirs, mine) => (theirs === mine ? null
  : message('info', theirs ? t('common.otherVersion', { theirs, mine }) : t('common.olderVersion', { mine })));

// Code de contrôle (voir trust.js), à comparer par téléphone avec l'autre personne.
export const controlLine = (label, code) => el('p', { class: 'control-code' }, label, ' ', el('strong', {}, code), el('br'),
  el('span', { class: 'muted small' }, t('common.controlHelp')));

// Bouton qui copie `text()` dans le presse-papiers ; `onFail` si le navigateur le refuse.
export function copyButton(text, label, onFail = () => {}) {
  const button = el('button', { class: 'btn', type: 'button' }, icon('copy'), label);
  button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text()); } catch (e) { onFail(); return; }
    button.lastChild.textContent = t('common.copied');
    setTimeout(() => { button.lastChild.textContent = label; }, 1500);
  });
  return button;
}

// Liste à cocher, filtrable au clavier (tables, colonnes, valeurs d'un filtre). `items` :
// [{ value, label, hint, keywords }] (`hint` : type de la colonne ou nombre de lignes, en discret ;
// `keywords` : texte cherché en plus du libellé ; `locked` : coché et grisé, que « Aucun » ne décoche pas).
// `checked` : valeurs cochées au départ. `onChange`
// reçoit les valeurs cochées, dans l'ordre de la liste. `label` nomme la liste. « Tous » et « Aucun »
// ne touchent que ce que la recherche trouve. `wide` : sur plusieurs colonnes quand la place le
// permet. Une longue liste prend la hauteur de son contenu jusqu'à 45 % de la fenêtre, puis
// s'étire à la souris. Au-delà de SHOWN_MAX éléments trouvés, les suivants attendent une
// recherche plus précise.
const LONG_LIST = 8;
const SHOWN_MAX = 300;
export function checkList({ items, checked = [], label = '', onChange, wide = false }) {
  const name = label ? t('common.filterIn', { name: label }) : t('common.filter');
  const filter = el('input', { class: 'search-input', type: 'search', placeholder: t('common.filter'), 'aria-label': name, autocomplete: 'off' });
  const long = items.length > LONG_LIST;
  const list = el('div', { class: `check-list${wide ? ' check-grid' : ''}${long ? ' check-long' : ''}`, role: 'group', 'aria-label': label || null });
  const locked = new Set(items.filter(it => it.locked).map(it => it.value));
  const chosen = new Set([...checked, ...locked]);
  const count = el('span', { class: 'check-count muted small', 'aria-live': 'polite' });
  const found = () => items.filter(it => matches(`${it.label} ${it.keywords || ''}`, filter.value));
  const changed = () => {
    count.textContent = t('common.checkedCount', { n: chosen.size, total: items.length });
    edited(list);
    onChange(items.map(i => i.value).filter(v => chosen.has(v)));
  };
  const render = () => {
    const all = found();
    const shown = all.slice(0, SHOWN_MAX);
    const more = all.length - shown.length;
    list.replaceChildren(...[...(shown.length ? shown.map(it => el('label', {},
      el('input', {
        type: 'checkbox', checked: chosen.has(it.value), disabled: locked.has(it.value),
        onchange: (e) => { if (e.target.checked) chosen.add(it.value); else chosen.delete(it.value); changed(); },
      }), el('span', { class: 'check-label' }, it.label), it.hint ? el('span', { class: 'hint' }, it.hint) : null)) : [el('p', { class: 'muted small' }, t('common.none'))]),
      more > 0 ? el('p', { class: 'muted small check-more' }, t('common.moreItems', { n: more })) : null].filter(Boolean));
  };
  const setShown = (on) => {
    for (const it of found()) if (on) chosen.add(it.value); else if (!locked.has(it.value)) chosen.delete(it.value);
    render();
    changed();
  };
  filter.addEventListener('input', render);
  render();
  count.textContent = t('common.checkedCount', { n: chosen.size, total: items.length });
  if (long) fitHeight(list);
  const tools = items.length > 1 ? el('div', { class: 'check-tools' }, filter,
    el('button', { class: 'btn btn-small', type: 'button', onclick: () => setShown(true) }, t('common.all')),
    el('button', { class: 'btn btn-small', type: 'button', onclick: () => setShown(false) }, t('common.noneChecked')),
    count) : filter;
  return el('div', { class: 'check-select' }, tools, list);
}

// Hauteur de départ d'une longue liste, prise la première fois qu'elle s'affiche (elle peut être
// repliée) : celle de son contenu, jusqu'à 45 % de la fenêtre. Ensuite, la poignée du coin
// l'agrandit sans limite.
function fitHeight(list) {
  if (typeof ResizeObserver === 'undefined') return;
  const watch = new ResizeObserver(() => {
    if (!list.offsetHeight) return;
    watch.disconnect();
    list.style.height = `${Math.min(list.scrollHeight + 2, Math.max(160, Math.round(window.innerHeight * 0.45)))}px`;
    list.style.maxHeight = 'none';
  });
  watch.observe(list);
}

// Choix d'une valeur dans une liste filtrable (tables, colonnes) : un bouton qui affiche le choix
// et ouvre la liste sous lui. `items` : [{ value, label }]. Échap referme la liste seule.
export function pickField({ items, value, label, onChange = () => {} }) {
  let current = value;
  const button = el('button', { class: 'btn pick-button', type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' });
  const filter = el('input', { class: 'search-input', type: 'search', placeholder: t('common.filter'), 'aria-label': t('common.filter'), autocomplete: 'off' });
  const list = el('div', { class: 'check-list', role: 'listbox', 'aria-label': label });
  const panel = el('div', { class: 'pick-panel hidden' }, filter, list);
  const field = el('div', { class: 'pick-field' }, button, panel);
  const shown = () => (items.find(it => it.value === current) || items[0] || { label: t('common.choose') }).label;
  // Le bouton dit le choix ; son nom accessible dit aussi le champ.
  const showChoice = () => { button.textContent = shown(); button.setAttribute('aria-label', `${label} : ${shown()}`); };
  const toggle = (open) => {
    panel.classList.toggle('hidden', !open);
    button.setAttribute('aria-expanded', String(open));
    if (open) { filter.value = ''; render(); filter.focus(); } else button.focus();
  };
  const choose = (v) => { current = v; showChoice(); toggle(false); edited(field); onChange(v); };
  function render() {
    const found = items.filter(it => matches(it.label, filter.value));
    list.replaceChildren(...(found.length ? found.map(it => el('button', {
      class: 'pick-option', type: 'button', role: 'option', 'aria-selected': String(it.value === current), onclick: () => choose(it.value),
    }, it.label)) : [el('p', { class: 'muted small' }, t('common.none'))]));
  }
  showChoice();
  button.addEventListener('click', () => toggle(panel.classList.contains('hidden')));
  filter.addEventListener('input', render);
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.classList.contains('hidden')) { e.stopPropagation(); toggle(false); }
    if (e.key === 'Enter' && e.target === filter) { e.preventDefault(); const first = list.querySelector('.pick-option'); if (first) first.click(); }
  });
  field.value = () => current;
  return field;
}

// Erreurs prévues, leur texte et les dernières erreurs vues : dans le moteur (engine/errors.js), qui ne
// dessine rien. Les écrans les prennent d'ici.
export { errorText, failure, noteError, recentErrors };

// Requête qui n'a pas abouti (réseau, ou document rechargé par Grist après un changement de règles).
export const unreachable = e => e instanceof TypeError && /fetch|load failed|network/i.test(e.message);

// Exécute une action d'un bouton : le bouton est grisé pendant l'opération, l'erreur affichée
// dans `out` (élément qui reçoit le message).
export async function run(button, out, fn) {
  if (button) button.disabled = true;
  if (out) out.replaceChildren();
  try {
    return await fn();
  } catch (e) {
    // Une erreur prévue (code mal copié, lien refusé) n'est qu'un message ; une requête coupée par le rechargement du document
    // (règles d'accès posées pendant l'action) n'est qu'un avertissement : le widget se recharge et reprend.
    if (!known(e)) (unreachable(e) ? console.warn : console.error)(e);
    noteError(e);
    if (out) out.replaceChildren(message('err', errorText(e)));
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

// Après un changement de règles d'accès (engine/acl.js), Grist recharge le document, et le widget
// avec lui : l'onglet le dit au lieu de se dessiner pour rien (un assistant ouvert serait fermé par le
// rechargement), et se redessine lui-même si le rechargement tarde (RELOAD_MS).
const RELOAD_MS = 8000;
export function reloading(root, render) {
  root.replaceChildren(message('info', t('common.reloading')));
  setTimeout(() => { if (root.isConnected) render(); }, RELOAD_MS);
}
