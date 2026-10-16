// Onglet « Recevoir » (document CIBLE) : une carte par export reçu, avec ses tables, ce qui manque,
// les arrivées suspectes, les valeurs retouchées à la main et l'historique des changements. Un
// journal encore vide attend son lien.
import { isBlank } from '../logic/common.js';
import { STATES, awaitingPartner } from '../logic/journal.js';
import { fetchRows, isReadOnly, readSchema } from '../grist.js';
import { dropPages, ensureForm, formPages, removeTechnicalTables, renewFormLink } from '../pages.js';
import { endExchange } from '../exchange.js';
import { legacyJournals, receivedJournals, updateJournalNote } from './journals.js';
import { consolidateAll, forgetJournal, isAccessError, restoreSource, state, tableKey } from './loop.js';
import { offerDialog } from './dest.js';
import { receiveWizard } from './wizard.js';
import { confirmDialog, el, errorText, icon, message, openModal, pickField, run } from '../ui.js';
import { roleGuide } from '../guide.js';
import { LANG, dateText, t } from '../i18n.js';

const HISTORY_MAX = 20;
const DRIFT_MAX = 10;
let container;
let wizardOpened = false; // l'assistant ne se rouvre seul qu'une fois par chargement
const offered = new Set(); // tables déjà proposées en fenêtre pendant ce chargement
// Historiques et lignes d'historique ouverts : repliés par défaut, ils le restent d'un dessin à
// l'autre de l'onglet (un passage qui change quelque chose le redessine).
const opened = new Set();
const keepOpen = id => e => (e.currentTarget.open ? opened.add(id) : opened.delete(id));

// Redessine l'onglet s'il est affiché (un passage de la recopie a changé quelque chose).
export async function refreshTarget() {
  if (container && container.isConnected) await renderTarget();
}

// Réceptions à montrer. Le journal de retour d'un Échange se règle depuis l'onglet Envoyer : il
// n'attend jamais son lien ici. `shared` : autres formulaires atteints par la même clé.
async function receivedGroups(schema) {
  const forms = await formPages();
  const groups = [];
  for (const { journal, note } of receivedJournals(schema).filter(r => !awaitingPartner(r.note))) {
    const known = state.results.get(journal);
    const rows = known ? known.rows : (await fetchRows(journal)).length;
    const waiting = note.mode !== 'public' && !note.retour && !rows;
    groups.push({ journal, note, public: note.mode === 'public', waiting, shared: (forms.get(journal) || {}).shared || 0 });
  }
  return groups;
}

const button = (label, iconName, onclick, kind = '') => el('button', { class: `btn btn-small ${kind}`, type: 'button', disabled: state.readOnly, onclick }, icon(iconName), label);

export async function renderTarget(root = container) {
  if (!container) state.viewer = isReadOnly();
  container = root;
  state.readOnly ||= state.viewer;
  const schema = await readSchema();
  const groups = await receivedGroups(schema);
  // Formulaire des exports en attente, chacun sur sa page.
  const out = el('div', { class: 'out' });
  try {
    for (const group of groups.filter(g => g.waiting)) await ensureForm(group.journal);
  } catch (e) {
    if (isAccessError(e)) state.readOnly = true; // un lecteur ne peut pas publier le formulaire
    else out.append(message('err', errorText(e)));
  }
  const legacy = legacyJournals(schema);
  const sync = async () => { if ((await consolidateAll({ reread: true })) === false) out.replaceChildren(message('ok', t('recv.sync.none'))); };
  const toolbar = el('div', { class: 'toolbar' },
    el('button', { class: 'btn btn-primary', type: 'button', disabled: state.readOnly, onclick: () => receiveWizard(null, renderTarget) }, icon('plus'), t('recv.new')),
    el('button', { class: 'btn', type: 'button', disabled: state.readOnly || !groups.length, onclick: e => run(e.currentTarget, out, sync) }, icon('refresh'), t('recv.action.sync')));
  const cards = groups.map(syncCard);
  if (legacy.length) cards.push(legacyCard(legacy, out));
  container.replaceChildren(...[toolbar,
    state.readOnly ? message('warn', t('common.readonly')) : null,
    out,
    cards.length ? el('div', { class: 'cards' }, cards, el('p', { class: 'muted small' }, t('recv.auto'))) : el('p', { class: 'muted' }, t('recv.empty')),
    roleGuide({ you: 'target' })].filter(Boolean));
  if (!state.readOnly) await openPending(groups);
}

// Ouvre seul, une fois par chargement : l'assistant d'une réception qui attend son lien, sinon la
// fenêtre d'une table ajoutée par la SOURCE.
async function openPending(groups) {
  dropPages(groups.map(g => g.journal)).catch(() => {});
  if (document.querySelector('.scrim')) return;
  const waiting = groups.find(g => g.waiting);
  if (waiting && !wizardOpened) {
    wizardOpened = true;
    receiveWizard(waiting, renderTarget);
    return;
  }
  for (const group of groups) {
    const offer = (state.offers.get(group.journal) || []).find(o => !offered.has(tableKey(group.journal, o.table)));
    if (!offer) continue;
    offered.add(tableKey(group.journal, offer.table));
    offerDialog(group, offer, renderTarget);
    return;
  }
}

function cardStatus(group) {
  const { journal, note } = group;
  if (group.waiting) return ['waiting', 'pending'];
  if (note.ended) return ['ended', 'off'];
  if ((state.results.get(journal) || {}).error || note.tables.some(tb => (state.results.get(tableKey(journal, tb.table)) || {}).error)) return ['error', 'err'];
  return Object.keys({ ...note.missing, ...note.big }).length ? ['incomplete', 'pending'] : ['ok', 'ok'];
}

// Une table reçue : origine → destination, heure du dernier passage, ou l'erreur. Le détail des
// changements est dans l'historique.
function tableLine(group, entry) {
  const journalResult = state.results.get(group.journal) || {};
  const result = state.results.get(tableKey(group.journal, entry.table)) || (journalResult.error ? journalResult : null);
  const detail = result && !group.waiting ? ` · ${new Date(result.at * 1000).toLocaleTimeString(LANG)}${result.error ? ` · ${result.text}` : ''}` : '';
  return el('p', { class: `small ${result && result.error ? 'text-danger' : 'muted'}` }, `${entry.table} → ${entry.dest}${detail}`);
}

// Avis d'une réception : envoi coupé par la SOURCE, lignes manquantes, trop grosses, instantané
// trop gros, lien partagé, arrivées suspectes, tables proposées ou refusées.
function cardNotes(group) {
  const { note } = group;
  return [
    note.ended ? message('warn', t('recv.ended', { at: dateText(note.ended * 1000) })) : null,
    Object.entries(note.missing || {}).map(([table, n]) => message('warn', t('recv.missing', { table, n }))),
    Object.entries(note.big || {}).map(([table, keys]) => message('warn', t('recv.big', { table, n: keys.length }))),
    (note.tooBig || []).length ? message('warn', t('recv.tooBig', { tables: note.tooBig.join(', ') })) : null,
    group.shared && !group.public ? alertBlock(t('recv.shared.title'), [t('recv.shared.body', { n: group.shared })], [button(t('recv.suspect.cut'), 'unlink', () => cutLink(group), 'btn-danger-text')]) : null,
    note.suspect ? suspectBlock(group) : null,
    (state.offers.get(group.journal) || []).map(o => el('div', { class: 'offer' }, el('span', { class: 'small' }, t('recv.offer.line', { table: o.table, n: o.n })),
      button(t('recv.offer.place'), 'plus', () => offerDialog(group, o, renderTarget), 'btn-primary'))),
    note.refused.length ? el('p', { class: 'muted small' }, t('recv.offer.refusedList', { tables: note.refused.join(', ') })) : null,
  ];
}

function syncCard(group) {
  const { note } = group;
  const [status, tone] = cardStatus(group);
  const from = (note.from || {}).email;
  const fromDoc = (note.from || {}).docId || '';
  return el('article', { class: 'card', 'data-journal': group.journal },
    el('div', { class: 'card-head' }, el('strong', {}, note.name), el('span', { class: `pill pill-${tone}` }, t(`recv.status.${status}`))),
    from ? el('p', { class: 'small' }, t(fromDoc ? 'recv.fromDoc' : 'recv.from', { from, doc: fromDoc })) : null,
    group.public ? el('p', { class: 'muted small' }, t('recv.public')) : null,
    note.mode === 'echange' ? el('p', { class: 'muted small' }, t('recv.exchange')) : null,
    note.tables.map(entry => tableLine(group, entry)),
    cardNotes(group),
    note.tables.map(entry => driftBlock(group, entry)),
    group.waiting ? null : history(group),
    el('div', { class: 'card-actions' },
      group.public || note.retour ? null : button(t(group.waiting ? 'recv.action.continue' : 'recv.action.link'), 'link', () => receiveWizard(group, renderTarget), group.waiting ? 'btn-primary' : ''),
      button(t('recv.action.stop'), 'stop', () => stopReceiving(group), 'btn-danger-text')));
}

const alertBlock = (title, lines, actions) => el('div', { class: 'msg msg-warn suspect', role: 'status' },
  el('strong', {}, title), lines.filter(Boolean).map(line => el('p', { class: 'small' }, line)), el('div', { class: 'card-actions' }, actions));

// Arrivées suspectes : lignes rejetées (elles ne pouvaient pas venir du webhook de cet export) et
// arrivée anormale. Le lien du formulaire est peut-être connu d'un autre : on peut le couper.
function suspectBlock(group) {
  const { n = 0, at, flood } = group.note.suspect;
  const dismiss = async (e) => {
    e.currentTarget.disabled = true;
    await updateJournalNote(group.journal, ({ suspect, ...note }) => note);
    await renderTarget();
  };
  return alertBlock(t('recv.suspect.title'), [
    n ? t('recv.suspect.rejected', { n, at: dateText(at * 1000) }) : null,
    flood ? t('recv.suspect.flood', { at: dateText(flood * 1000) }) : null,
    t('recv.suspect.help'),
  ], [button(t('recv.suspect.cut'), 'unlink', () => cutLink(group), 'btn-danger-text'), button(t('recv.suspect.dismiss'), 'check', dismiss)]);
}

// Couper le lien : le formulaire de cette réception prend une nouvelle clé, sur sa propre page. La
// SOURCE révoque l'ancien destinataire et envoie une nouvelle invitation, acceptée ici sur la même
// réception.
async function cutLink(group) {
  if (!(await confirmDialog({ title: t('recv.cut.title'), body: t('recv.cut.body'), confirmLabel: t('recv.suspect.cut') }))) return;
  await updateJournalNote(group.journal, ({ suspect, ...note }) => note);
  await renewFormLink(group.journal);
  await renderTarget();
  container.querySelector('.out').replaceChildren(message('ok', t('recv.cut.done')));
}

// Réceptions d'avant la version 0.4 (un journal par table) : à refaire avec la SOURCE.
function legacyCard(journals, out) {
  const clean = async () => {
    if (!(await confirmDialog({ title: t('recv.legacy.title'), body: t('recv.legacy.confirm'), confirmLabel: t('recv.legacy.clean') }))) return;
    await removeTechnicalTables(journals);
    await renderTarget();
  };
  return el('article', { class: 'card' },
    el('div', { class: 'card-head' }, el('strong', {}, t('recv.legacy.title')), el('span', { class: 'pill pill-pending' }, t('send.status.legacy'))),
    el('p', { class: 'small' }, t('recv.legacy.body', { tables: journals.join(', ') })),
    el('div', { class: 'card-actions' }, button(t('recv.legacy.clean'), 'trash', e => run(e.currentTarget, out, clean), 'btn-danger-text')));
}

// Arrêter de recevoir : efface le journal (et son formulaire, donc la clé d'écriture) ; les tables
// de destination et leurs lignes restent. Un Échange s'arrête dans les deux sens (voir endExchange).
async function stopReceiving(group) {
  const { note } = group;
  const exchange = note.mode === 'echange';
  const body = t(exchange ? 'send.revoke.exchange' : 'recv.stop.body', { journal: group.journal });
  if (!(await confirmDialog({ title: t('recv.stop.title', { name: note.name }), body, confirmLabel: t('recv.action.stop') }))) return;
  if (exchange) await endExchange(note.export, { keepExport: Boolean(note.retour) });
  else await removeTechnicalTables([group.journal]);
  forgetJournal(group.journal);
  await renderTarget();
}

// ---------------------------------------------------------------------------------------------
// Valeurs en petit tableau, comme dans une vue Grist.

// Texte d'une valeur reçue ou lue dans la destination : liste de choix, date, case à cocher.
function cellText(value, type = '') {
  if (Array.isArray(value)) return value[0] === 'L' ? value.slice(1).join(', ') : JSON.stringify(value);
  if (typeof value === 'boolean') return t(value ? 'common.yes' : 'common.no');
  if (typeof value === 'number' && /^Date/.test(type)) {
    const zone = type.startsWith('DateTime:') ? type.slice(9) : 'UTC';
    try {
      const date = new Date(value * 1000);
      return type.startsWith('DateTime') ? date.toLocaleString(LANG, { timeZone: zone }) : date.toLocaleDateString(LANG, { timeZone: 'UTC' });
    } catch (e) { /* fuseau inconnu : la valeur brute */ }
  }
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
}

const cell = (value, type, kind = '') => {
  if (isBlank(value)) return el('td', { class: `${kind} mg-blank` }, t('common.blank'));
  const text = cellText(value, type);
  return el('td', { class: kind, title: text }, text);
};

const miniGrid = (head, rows) => el('div', { class: 'mini-grid-wrap' }, el('table', { class: 'mini-grid' },
  el('thead', {}, el('tr', {}, head.map(h => el('th', { scope: 'col' }, h)))), el('tbody', {}, rows)));

// Retouches faites à la main dans une destination : colonnes reçues effacées, cellules qui
// diffèrent de la dernière version reçue (avec leur numéro de ligne), lignes reçues effacées. Elles
// restent jusqu'à ce que la SOURCE change leur ligne, ou que l'on clique sur « Corriger ».
function driftBlock(group, entry) {
  const result = state.results.get(tableKey(group.journal, entry.table)) || {};
  const total = result.driftCount || 0;
  if (!total) return null;
  const types = result.types || {};
  const said = (text, span) => el('td', { class: 'mg-here', colspan: String(span) }, text);
  const rows = [
    ...(result.droppedCols || []).map(([, to]) => el('tr', {}, el('td', {}), el('td', {}), el('td', {}, to), said(t('recv.drift.colGone'), 2))),
    ...(result.drift || []).flatMap(d => (d.gone
      ? [el('tr', {}, el('td', { class: 'mg-n' }), el('td', { title: d.label }, d.label), said(t('recv.drift.rowGone'), 3))]
      : d.cells.map(([from, to, here, source]) => el('tr', {}, el('td', { class: 'mg-n' }, d.n ? String(d.n) : ''), el('td', { title: d.label }, d.label),
        el('td', {}, to), cell(here, types[from], 'mg-here'), cell(source, types[from], 'mg-source'))))),
  ].slice(0, DRIFT_MAX);
  return el('div', { class: 'msg msg-warn drift', role: 'status' },
    el('strong', {}, t('recv.drift.title', { dest: entry.dest, n: total })),
    el('p', { class: 'small' }, t('recv.drift.body', { n: total })),
    miniGrid([t('recv.drift.row'), result.labelCol || '', t('recv.drift.col'), t('recv.drift.here'), t('recv.drift.source')], rows),
    total > rows.length ? el('p', { class: 'small' }, t('recv.history.more', { n: total - rows.length })) : null,
    el('div', { class: 'card-actions' }, button(t('recv.drift.fix'), 'check', e => run(e.currentTarget, container.querySelector('.out'), () => correct(group, entry, result)))));
}

// « Corriger » : la table reprend l'état exact de la SOURCE, après confirmation.
async function correct(group, entry, { driftCount, driftGone = 0, droppedCols = [] }) {
  const body = [t('recv.drift.fixBody', { n: driftCount }), driftGone ? t('recv.drift.fixRows', { n: driftGone }) : '',
    droppedCols.length ? t('recv.drift.fixCols', { n: droppedCols.length }) : ''].filter(Boolean).join(' ');
  if (!(await confirmDialog({ title: t('recv.drift.fixTitle', { dest: entry.dest }), body, confirmLabel: t('recv.drift.fix') }))) return;
  await restoreSource(group.journal, entry.table);
  await renderTarget();
}

// ---------------------------------------------------------------------------------------------
// Historique : lignes changées depuis la visite précédente, par table de destination : compteurs
// par état (ajoutées, modifiées, supprimées, et colonnes ajoutées par la SOURCE), puis les plus
// récentes (HISTORY_MAX par table),
// numérotées comme dans la table et nommées par la colonne choisie pour chaque table. Chacune
// s'ouvre au clic sur son avant et son après. Tout est replié par défaut.

const STATE_ICON = { ajout: 'plus', modif: 'edit', suppression: 'minus', colonne: 'column' };
const COUNTED = [...STATES, 'colonne'];

function stateCounts(items) {
  return el('span', { class: 'history-counts' }, COUNTED.map((st) => {
    const n = items.filter(c => c.state === st).length;
    return n ? el('span', { class: `chg chg-${st}` }, icon(STATE_ICON[st]), t(`recv.history.n.${st}`, { n })) : null;
  }));
}

function when(at) {
  const date = new Date(at * 1000);
  const today = date.toDateString() === new Date().toDateString();
  return today ? date.toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString(LANG, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function historyRow(c, types, id) {
  const gone = c.state === 'suppression';
  const line = [
    el('span', { class: 'chg-n', title: c.n ? t(gone ? 'recv.history.rowGone' : 'recv.history.row', { n: c.n }) : null }, c.n ? String(c.n) : ''),
    el('span', { class: 'chg-dot', title: t(`recv.history.${c.state}`) }, icon(STATE_ICON[c.state])),
    el('span', { class: 'chg-label' }, c.state === 'colonne' ? t('recv.history.colLabel', { col: c.label }) : c.label || '—'),
    el('span', { class: 'chg-state' }, t(`recv.history.${c.state}`)),
    el('time', { class: 'chg-time', datetime: new Date(c.at * 1000).toISOString() }, when(c.at))];
  const rowClass = `chg-row chg-${c.state}`;
  if (!c.detail) return el('li', { class: `chg-item chg-${c.state}` }, el('div', { class: rowClass }, line));
  const { cols, before, after } = c.detail;
  const values = (kind, list) => list && el('tr', { class: `mg-${kind}` }, el('th', { scope: 'row' }, t(`recv.history.${kind}`)),
    list.map((v, i) => cell(v, types[cols[i][0]])));
  return el('li', { class: `chg-item chg-${c.state}` }, el('details', { open: opened.has(id), ontoggle: keepOpen(id) },
    el('summary', { class: rowClass }, line),
    miniGrid(['', ...cols.map(([, to]) => to)], [values('before', before), values('after', after)])));
}

const historyTable = ({ id, dest, items, types }) => (items.length ? el('section', { class: 'history-table' },
  el('div', { class: 'history-head' }, el('strong', {}, dest), stateCounts(items)),
  el('ul', { class: 'history-rows' }, items.slice(0, HISTORY_MAX).map(c => historyRow(c, types, `${id}|${c.key}|${c.at}`))),
  items.length > HISTORY_MAX ? el('p', { class: 'muted small' }, t('recv.history.more', { n: items.length - HISTORY_MAX })) : null) : null);

function history(group) {
  const tables = group.note.tables.map((tb) => {
    const result = state.results.get(tableKey(group.journal, tb.table)) || {};
    // Une colonne ajoutée par la SOURCE prend place parmi les lignes, à son heure.
    const columns = (result.added || []).map(a => ({ at: a.at, key: `col:${a.col}`, state: 'colonne', label: a.col, n: null, detail: null }));
    const items = [...columns, ...(result.recent || [])].sort((x, y) => y.at - x.at);
    return { id: tableKey(group.journal, tb.table), dest: tb.dest, items, types: result.types || {} };
  });
  const all = tables.flatMap(tb => tb.items);
  if (!all.length) return el('p', { class: 'muted small' }, t('recv.history.none'));
  return el('details', { class: 'history', open: opened.has(group.journal), ontoggle: keepOpen(group.journal) },
    el('summary', {}, el('span', { class: 'history-title' }, t(state.lastVisit ? 'recv.history.since' : 'recv.history.last')), stateCounts(all)),
    tables.map(historyTable),
    el('button', { class: 'btn btn-small btn-link', type: 'button', disabled: state.readOnly, onclick: () => labelDialog(group) }, t('recv.label.change')));
}

// Colonne qui nomme les lignes dans l'historique, par table reçue (notée dans le journal).
function labelDialog(group) {
  const pickers = group.note.tables.map((entry) => {
    const result = state.results.get(tableKey(group.journal, entry.table)) || {};
    const cols = result.labelCols || [];
    return { entry, field: pickField({ items: cols.map(c => ({ value: c, label: c })), value: result.labelCol || cols[0], label: entry.dest }) };
  });
  const report = el('div', { class: 'report' });
  const save = async (m) => {
    await updateJournalNote(group.journal, note => ({
      ...note, tables: note.tables.map(tb => ({ ...tb, label: (pickers.find(p => p.entry.table === tb.table) || {}).field.value() })),
    }));
    m.close();
    state.results.clear();
    await consolidateAll();
  };
  openModal({
    title: t('recv.label.title'), width: 400,
    body: [el('p', { class: 'small' }, t('recv.label.help')), ...pickers.map(p => el('div', { class: 'dest-row' }, el('span', {}, p.entry.dest), p.field)), report],
    buttons: [{ label: t('common.cancel') }, { label: t('common.save'), kind: 'btn-primary', onClick: m => run(null, report, () => save(m)) }],
  });
}
