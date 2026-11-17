// Onglet « Recevoir » (document CIBLE) : une carte par export reçu, avec ses tables, ce qui manque,
// les arrivées suspectes, les valeurs retouchées à la main et l'historique des changements. Un
// journal encore vide attend son lien.
import { RECEIVED_COL, TYPE_COL, isBlank } from '../engine/logic/common.js';
import { REFUSED, STATES, awaitingPartner } from '../engine/logic/journal.js';
import { FILE_MAX, fileList } from '../engine/logic/files.js';
import { docIdentity, fetchRows, isOwner, isReadOnly, journalStats, readSchema } from '../grist.js';
import { diagnostic } from '../diagnostic.js';
import { syncRules } from '../engine/acl.js';
import { dropPages, ensureForm, formPages, removeTechnicalTables, renewFormLink } from '../engine/pages.js';
import { closeExport } from '../engine/exchange.js';
import { updateJournalNote } from '../engine/target/journals.js';
import { dismissLost, markReceptions, readLost } from '../engine/target/lost.js';
import { receivedJournals, receivedKey } from '../engine/logic/received.js';
import { currencyOf, formatGap } from '../engine/logic/docformat.js';
import { consolidateAll, decide, forgetJournal, isAccessError, relink, restoreSource, restyle, state, tableKey } from '../engine/target/loop.js';
import { alignDocFormat, readDocFormat } from '../engine/target/style.js';
import { SHOWN } from '../engine/logic/report.js';
import { TALLY_GRACE_S } from '../engine/logic/tally.js';
import { uploadErrors } from '../engine/target/files.js';
import { offerDialog } from './dest.js';
import { rulesRefusedNotice } from '../rules-notice.js';
import { wizardAsked } from '../prefs.js';
import { protectMemos } from '../engine/source/synchro.js';
import { cleanJournal } from '../engine/target/clean.js';
import { ownsSync } from '../engine/logic/strays.js';
import { optionsDialog } from './options.js';
import { restyleDialog } from './restyle.js';
import { addWidgetFor, readWidgetSpots, widgetCandidates, widgetLabel } from './widget-page.js';
import { receiveWizard } from './wizard.js';
import { reinforceKind, reinforceNotes } from './reinforce.js';
import { structureNotes } from './structure.js';
import { sourceLine } from './source-line.js';
import { cancelButton, confirmDialog, copyField, el, errorText, icon, message, noteError, notice, openModal, pickField, pill, redraw, reloading, run, smallButton } from '../ui.js';
import { roleGuide } from '../guide.js';
import { LANG, dateText, t, timeText } from '../i18n.js';

const HISTORY_MAX = 20;
let container;
let wizardOpened = false; // l'assistant ne se rouvre seul qu'une fois par chargement
// Avis de la dernière action (lien coupé), gardé une minute : le passage de recopie qui suit
// l'action redessine l'onglet (vu au test : l'avis disparaissait aussitôt).
let flash = null; // { node, until }
const NOTICE_MS = 60000;
const lastNotice = () => (flash && Date.now() < flash.until ? flash.node : null);
const offered = new Set(); // tables déjà proposées en fenêtre pendant ce chargement
let lostList = []; // réceptions dont le journal a été supprimé, relues à chaque ouverture de l'onglet (voir readLost)
// Historiques et lignes d'historique ouverts : repliés par défaut, ils le restent d'un dessin à
// l'autre de l'onglet (un passage qui change quelque chose le redessine).
const opened = new Set();
const keepOpen = id => e => (e.currentTarget.open ? opened.add(id) : opened.delete(id));

// Redessine l'onglet s'il est affiché (un passage de la recopie a changé quelque chose).
// Redessin périodique (après un passage) : il ne touche pas aux règles d'accès, dont le changement
// rechargerait le widget au milieu d'une action en cours (voir syncRules).
export async function refreshTarget() {
  if (container && container.isConnected) await renderTarget(container, { periodic: true });
}

// Réceptions à montrer. Le journal de retour d'un Échange se règle depuis l'onglet Envoyer : il
// n'attend jamais son lien ici. `shared` : autres formulaires atteints par la même clé.
// `owner` : la personne pose les règles d'accès elle-même (voir syncRules) ; sinon, un journal
// réservé aux éditeurs ne l'est qu'une fois qu'un propriétaire a ouvert la page (`reserved`).
async function receivedGroups(schema, owner) {
  const forms = await formPages();
  const docHere = await readDocFormat().catch(() => null); // langue et monnaie de ce document (voir formatNotes)
  const groups = [];
  for (const { journal, note } of receivedJournals(schema).filter(r => !awaitingPartner(r.note))) {
    const known = state.results.get(journal);
    // Un premier passage en erreur (clé perdue, table effacée) n'a pas compté les lignes : le journal en a peut-être.
    const rows = known && Number.isFinite(known.rows) ? known.rows : (await fetchRows(journal)).length;
    const waiting = note.mode !== 'public' && !note.retour && !rows;
    const stats = waiting ? null : await journalStats(journal, RECEIVED_COL, TYPE_COL);
    groups.push({ journal, note, public: note.mode === 'public', waiting, ...receptionFlags({ schema, journal, note, waiting, owner, forms }), owner, docHere, stats, shared: (forms.get(journal) || {}).shared || 0 });
  }
  return groups;
}

// Ce que l'état d'une réception déjà branchée demande de dire : `unsigned` (aucune clé de signature jamais vue :
// réception d'avant la 0.8, qu'une clé perdue arrête, voir sealing dans loop.js), `unreserved` (journal réservé aux
// éditeurs, pas encore posé par un propriétaire), `formGone` (formulaire dépublié ou page supprimée : la SOURCE ne
// peut plus écrire).
function receptionFlags({ schema, journal, note, waiting, owner, forms }) {
  const linked = note.mode !== 'public';
  return {
    unsigned: linked && !note.sceau && !receivedKey(schema, journal, note),
    unreserved: Boolean(note.reserve) && !note.reserved && !owner,
    formGone: linked && !note.retour && !waiting && !forms.has(journal),
  };
}

// Réceptions branchées avant les clés de signature (« Vos partages », js/news.js) : le nombre qui se renforce.
export async function reinforceReceptions() {
  const schema = await readSchema();
  return receivedJournals(schema).filter(({ journal, note }) => note.mode === 'reponse' || !note.mode)
    .filter(({ journal, note }) => !note.retour && !note.sceau && !receivedKey(schema, journal, note)).length;
}

const button = (label, iconName, onclick, kind = '') => smallButton(label, iconName, onclick, { kind, disabled: state.readOnly });

// Instance de CE document : le lien vers le document de la SOURCE en est refait (il ne quitte pas l'instance).
let here = '';
const knowHere = async () => { here ||= await docIdentity().then(d => d.origin, () => ''); };

// Une invitation arrivée d'un autre onglet (tab-link.js) : l'onglet Recevoir s'affiche, puis l'assistant s'ouvre sur son code.
export const receiveOffered = code => receiveWizard(null, renderTarget, code);

// Formulaire des exports en attente, chacun sur sa page (l'assistant le crée ; remis s'il a été effacé, pas à chaque
// redessin périodique), et la marque que chaque réception garde dans le partage de son formulaire pour dire qu'elle a
// existé si son journal est supprimé. Un lecteur ne peut pas publier le formulaire : l'écran passe en lecture seule.
async function prepareReceptions(groups, { owner, periodic }, out) {
  try {
    for (const group of groups.filter(g => g.waiting && !periodic)) await ensureForm(group.journal, { below: group.note.tables.map(tb => tb.dest), note: group.note });
    if (!periodic && owner) await markReceptions(groups.filter(g => !g.waiting)).catch(e => console.warn(e)); // un détail : jamais une raison de passer en lecture seule
    if (!periodic) lostList = await readLost();
    if (!periodic) await readWidgetSpots(groups);
  } catch (e) {
    if (isAccessError(e)) state.readOnly = true;
    else out.append(message('err', errorText(e)));
  }
}

function targetToolbar(groups, out) {
  const sync = async () => { if ((await consolidateAll({ reread: true })) === false) out.replaceChildren(message('ok', t('recv.sync.none'))); };
  return el('div', { class: 'toolbar' },
    el('button', { class: 'btn btn-primary', type: 'button', disabled: state.readOnly, onclick: () => receiveWizard(null, renderTarget) }, icon('plus'), t('recv.new')),
    el('button', { class: 'btn', type: 'button', disabled: state.readOnly || !groups.length, onclick: e => run(e.currentTarget, out, sync) }, icon('refresh'), t('recv.action.sync')));
}

export async function renderTarget(root = container, { periodic = false } = {}) {
  if (!container) state.viewer = isReadOnly();
  await knowHere();
  container = root;
  state.readOnly ||= state.viewer;
  // Règles d'accès du widget (journaux cachés aux lecteurs, Synchro d'un Échange réservée aux
  // propriétaires) : seul un propriétaire peut les poser.
  const owner = !state.readOnly && await isOwner().catch(() => true);
  if (!periodic && owner && await syncRules()) {
    reloading(container, renderTarget);
    return;
  }
  const schema = await readSchema();
  if (!periodic && owner && ownsSync(schema)) await protectMemos(); // Échange : le webhook de retour garde la fiche de la SOURCE hors de son mémo
  const groups = await receivedGroups(schema, owner || state.viewer);
  const out = el('div', { class: 'out' }, lastNotice());
  await prepareReceptions(groups, { owner, periodic }, out);
  redraw(container, targetPage(groups, groups.map(safeCard), { owner, out }));
  if (!state.readOnly) await openPending(groups, periodic);
  // « Accepter une invitation » demandé juste avant le rechargement que la pose des règles d'accès de Synchro a causé (Échange).
  if (!periodic && !state.readOnly && wizardAsked('reception', { consume: true }) && !document.querySelector('.scrim')) receiveWizard(null, renderTarget);
}

// L'écran de Recevoir : barre d'actions, avis, réceptions (ou ce qui explique qu'il n'y en a pas), aide.
function targetPage(groups, cards, { owner, out }) {
  const empty = el('p', { class: 'muted' }, t(state.readOnly ? 'recv.emptyViewer' : 'recv.empty'));
  return [targetToolbar(groups, out),
    state.readOnly ? message('warn', t('common.readonly')) : null,
    owner ? rulesRefusedNotice() : null,
    out,
    lostList.length ? el('div', { class: 'cards' }, lostList.map(lost => lostCard(lost, owner))) : null,
    cards.length ? el('div', { class: 'cards' }, cards, el('p', { class: 'muted small', title: t('recv.auto.detail') }, t('recv.auto'))) : empty,
    roleGuide({ you: 'target' })].filter(Boolean);
}

// Ouvre seul, une fois par chargement : l'assistant d'une réception qui attend son lien, sinon la
// fenêtre d'une table ajoutée par la SOURCE. Les journaux n'ont pas de page (ménage hors redessin
// périodique).
async function openPending(groups, periodic) {
  if (!periodic) dropPages(groups.map(g => g.journal)).catch(() => {});
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
    run(null, container.querySelector('.out'), () => offerDialog(group, offer, renderTarget));
    return;
  }
}

function cardStatus(group) {
  const { journal, note } = group;
  if (group.waiting) return ['waiting', 'pending'];
  if (note.ended) return ['ended', 'off'];
  if (reinforceKind(group) === 'expired') return ['error', 'err'];
  const tables = note.tables.map(tb => state.results.get(tableKey(journal, tb.table)) || {});
  if ((state.results.get(journal) || {}).error || tables.some(r => r.error)) return ['error', 'err'];
  // Changements d'un Échange à valider, colonnes ou table déjà remplie qui attendent l'accord de la personne (voir structure.js).
  if (tables.some(r => r.pendingCount || (r.structure && (r.structure.adoption || r.structure.held.length)))) return ['review', 'pending'];
  const incomplete = Object.keys({ ...note.missing, ...note.big, ...(state.results.get(journal) || {}).tally }).length || tables.some(r => r.files && (r.files.waiting || r.files.held));
  if (incomplete) return ['incomplete', 'pending'];
  // Les données sont à jour, mais le widget n'est sur la page d'aucune table reçue : il s'arrête dès qu'on les ouvre (voir widgetNotice).
  return widgetCandidates(group).length ? ['widget', 'pending'] : ['ok', 'ok'];
}

// Pièces jointes d'une table reçue : fichiers attendus (ils partent quand un propriétaire de la
// SOURCE ouvre la page du widget), lignes d'un Échange qui les attendent avant d'être recopiées, trop
// gros pour partir, refusés par Grist ici ; aucun par lien public.
const MB = 1024 * 1024;
const megabytes = bytes => (bytes / MB).toLocaleString(LANG, { maximumFractionDigits: 1 });
function filesNotes(group, entry) {
  const { files } = state.results.get(tableKey(group.journal, entry.table)) || {};
  if (!files) return null;
  const named = list => list.map(f => t('recv.files.named', { name: f.name, size: megabytes(f.size) })).join(', ');
  return [
    files.public ? message('info', t('recv.files.public', { dest: entry.dest })) : null,
    files.held ? message('info', t('recv.files.held', { n: files.held, dest: entry.dest }))
      : files.waiting ? message('info', t('recv.files.waiting', { n: files.waiting, dest: entry.dest })) : null,
    files.big.length ? message('warn', t(files.held ? 'recv.files.bigHeld' : 'recv.files.big', { files: named(files.big), max: FILE_MAX / MB })) : null,
  ];
}

// Une table reçue : origine → destination, heure du dernier passage, ou l'erreur. Le détail des
// changements est dans l'historique.
function tableLine(group, entry) {
  const journalResult = state.results.get(group.journal) || {};
  const result = state.results.get(tableKey(group.journal, entry.table)) || (journalResult.error ? journalResult : null);
  const detail = result && !group.waiting ? ` · ${timeText(result.at)}${result.error ? ` · ${result.text}` : ''}` : '';
  return el('p', { class: `small ${result && result.error ? 'text-danger' : 'muted'}` }, `${entry.table} → ${entry.dest}${detail}`);
}

// Avis d'une réception : envoi coupé par la SOURCE, lignes manquantes, trop grosses, instantané
// trop gros, lien partagé, arrivées suspectes, tables proposées ou refusées.
const cardNotes = group => [arrivalNotes(group), ...stateNotes(group), ...structureNotes(group, { rerender: renderTarget, out: () => container.querySelector('.out'), readOnly: state.readOnly }), ...gapNotes(group), ...formatNotes(group), ...linkNotes(group)];

// L'état de la réception : envoi coupé, formulaire disparu, clé de signature, droits.
function stateNotes(group) {
  const { note } = group;
  const locked = note.tables.some(entry => (state.results.get(tableKey(group.journal, entry.table)) || {}).locked);
  return [
    note.ended ? message('warn', t('recv.ended', { at: dateText(note.ended * 1000) })) : null,
    group.formGone ? message('err', t('recv.formGone')) : null,
    reinforceNotes(group, { rerender: renderTarget, out: () => container.querySelector('.out'), readOnly: state.readOnly }),
    group.unreserved ? message('info', t('recv.reserve.owner')) : null,
    locked ? message('info', t('recv.lock.waiting')) : null,
  ];
}

// Langue et monnaie du document de la SOURCE (elle les envoie avec sa mise en forme) différentes de celles de ce
// document : Grist écrit les séparateurs des nombres et la monnaie par défaut d'après le réglage du document,
// pas d'après la colonne. Seul un propriétaire peut régler le document, sur un clic confirmé : le réglage change
// l'écriture de toutes ses tables.
function formatNotes(group) {
  const { note } = group;
  const source = (note.tables.find(entry => entry.sourceDoc) || {}).sourceDoc;
  const gap = source && group.docHere && note.mode !== 'echange' ? formatGap(source, group.docHere) : null;
  if (!gap) return [];
  const label = format => [format.locale || 'en-US', currencyOf(format)].filter(Boolean).join(' · ');
  const align = async () => {
    if (!(await confirmDialog({ title: t('recv.format.confirmTitle'), body: t('recv.format.confirmBody', { source: label(source) }), confirmLabel: t('recv.format.action'), kind: 'btn-primary' }))) return;
    await alignDocFormat(source);
    flash = { node: message('ok', t('recv.format.done', { source: label(source) })), until: Date.now() + NOTICE_MS };
    await renderTarget();
  };
  return [notice({
    tone: 'info', className: 'format', title: t('recv.format.title'),
    lines: [t('recv.format.body', { source: label(source), here: label(group.docHere) }), group.owner ? null : t('recv.format.owner')],
    actions: group.owner ? [button(t('recv.format.action'), 'settings', e => run(e.currentTarget, container.querySelector('.out'), align))] : [],
  })];
}

// Ce que l'export reçu envoie en plus des données, d'après le sort de ses tables (`sends`, voir loop.js) : 'style', 'notes', 'table', 'formulas'.
const sentKinds = group => [...new Set(group.note.tables.flatMap(entry => entry.sends || []))];

// « Reprendre depuis la SOURCE » : les éléments cochés (parmi ceux que l'export envoie) reprennent la valeur de la
// SOURCE dans les colonnes reçues, après confirmation. Les formules (Python) sont à part : voir restyle.js.
async function restyleReception(group) {
  const kinds = sentKinds(group);
  const formulas = kinds.includes('formulas')
    ? group.note.tables.map(entry => ({ table: entry.dest, items: (state.results.get(tableKey(group.journal, entry.table)) || {}).formulas || [] })).filter(f => f.items.length)
    : [];
  const chosen = await restyleDialog({ name: group.note.name, kinds, owner: group.owner, formulas });
  if (!chosen || !chosen.size) return;
  await restyle(group.journal, Object.fromEntries([...chosen].map(kind => [kind, true])));
  flash = { node: message('ok', t('recv.restyle.done')), until: Date.now() + NOTICE_MS };
  await renderTarget();
}

// Les lignes qui n'arrivent pas : manquantes (envoi en morceaux), annoncées mais pas reçues, trop grosses, instantané trop gros.
function gapNotes(group) {
  const { note } = group;
  return [
    Object.entries(note.missing || {}).map(([table, n]) => message('warn', t('recv.missing', { table, n }))),
    Object.entries((state.results.get(group.journal) || {}).tally || {}).map(([table, g]) => message('warn', t('recv.tally', { table, ...g, min: TALLY_GRACE_S / 60 }))),
    Object.entries(note.big || {}).map(([table, keys]) => message('warn', t('recv.big', { table, n: keys.length }))),
    (note.tooBig || []).length ? message('warn', t('recv.tooBig', { tables: note.tooBig.join(', ') })) : null,
  ];
}

// Le lien et les tables : formulaire partagé, arrivées suspectes, tables proposées ou refusées.
function linkNotes(group) {
  const { note } = group;
  return [
    group.shared && !group.public ? alertBlock(t('recv.shared.title'), [t('recv.shared.body', { n: group.shared })], [button(t('recv.suspect.cut'), 'unlink', () => cutLink(group), 'btn-danger-text')]) : null,
    note.suspect ? suspectBlock(group) : null,
    (state.offers.get(group.journal) || []).map(o => el('div', { class: 'offer' }, el('span', { class: 'small' }, t('recv.offer.line', { table: o.table, n: o.n })),
      button(t('recv.offer.place'), 'plus', e => run(e.currentTarget, container.querySelector('.out'), () => offerDialog(group, o, renderTarget)), 'btn-primary'))),
    note.refused.length ? el('p', { class: 'muted small' }, t('recv.offer.refusedList', { tables: note.refused.join(', ') })) : null,
  ];
}

// Ce qui est arrivé dans le journal : dernier envoi, nombre de lignes, et les envois arrivés qui ne
// sont pas encore recopiés (la recopie ne tourne que page ouverte et visible).
function arrivalNotes({ stats, waiting }) {
  if (waiting || !stats || !stats.n) return null;
  return [
    stats.last ? el('p', { class: 'muted small' }, t('recv.arrival', { at: dateText(stats.last * 1000), n: stats.n })) : null,
    stats.raw ? message('info', t('recv.arrival.raw', { n: stats.raw })) : null,
  ];
}

const reportButton = () => smallButton(t('recv.action.report'), 'copy', (e) => {
  const out = e.currentTarget.closest('.card').querySelector('.report-out');
  return run(e.currentTarget, out, () => copyReport(out));
});

// Copie l'état de ce document (diagnostic : sans code, lien ni valeur des tables) pour le coller dans
// un message à la personne qui envoie. Si le presse-papiers refuse, le texte est montré à copier.
async function copyReport(out) {
  const text = await diagnostic();
  try {
    await navigator.clipboard.writeText(text);
    out.replaceChildren(message('ok', t('recv.report.copied')));
  } catch (e) {
    out.replaceChildren(message('warn', t('recv.report.failed')), copyField(text, t('recv.action.report')));
  }
}

function syncCard(group) {
  const { note } = group;
  const [status, tone] = cardStatus(group);
  return el('article', { class: 'card', 'data-journal': group.journal },
    el('div', { class: 'card-head' }, el('strong', {}, note.name), pill(t(`recv.status.${status}`), tone)),
    cardOrigin(group),
    note.tables.map(entry => tableLine(group, entry)),
    widgetNotice(group),
    cardNotes(group),
    note.tables.map(entry => filesNotes(group, entry)),
    uploadErrors(group.journal).map(e => message('warn', t('recv.files.refused', { name: e.name, error: e.error }))),
    note.tables.map(entry => [reviewBlock(group, entry), gapBlock(group, entry), driftBlock(group, entry), linksBlock(group, entry)]),
    group.waiting ? null : history(group),
    el('div', { class: 'report-out' }),
    el('div', { class: 'card-actions' },
      group.public || note.retour ? null : linkButton(group),
      group.public || note.mode === 'echange' ? null : button(t('recv.action.options'), 'settings', () => optionsDialog(group, group.owner, renderTarget)),
      group.waiting || note.mode === 'echange' || !sentKinds(group).length ? null : button(t('recv.action.restyle'), 'column', e => run(e.currentTarget, container.querySelector('.out'), () => restyleReception(group))),
      group.waiting || !group.owner ? null : button(t('recv.action.clean'), 'trash', e => run(e.currentTarget, container.querySelector('.out'), () => cleanReception(group))),
      group.waiting ? null : reportButton(),
      button(t('recv.action.stop'), 'stop', () => stopReceiving(group), 'btn-danger-text')));
}

// Le widget n'est sur la page d'aucune table de cette réception (voir widget-page.js) : la recopie s'arrête dès que la personne
// ouvre une de ces tables. Avis orange (l'état de la carte aussi, voir cardStatus) avec le bouton « Ajouter le widget à la page de
// la table reçue », qui disparaît avec l'avis dès que le widget est sur la page d'une table de la réception. Le résultat de la
// dernière action est gardé une minute, comme les autres (`flash`).
function widgetNotice(group) {
  const candidates = widgetCandidates(group);
  if (!candidates.length) return null;
  const add = async () => {
    const done = await addWidgetFor(group);
    if (!done) return;
    flash = { node: message(done.added ? 'ok' : 'info', t(done.added ? 'recv.widget.done' : 'recv.widget.already', { table: done.dest })), until: Date.now() + NOTICE_MS };
    await renderTarget();
  };
  return notice({
    tone: 'warn', title: t('recv.widget.missing.title'), 'data-widget-missing': '',
    lines: [candidates.length === 1 ? t('recv.widget.missing.one', { table: candidates[0] }) : t('recv.widget.missing.some'), t('recv.widget.missing.next')],
    actions: [button(widgetLabel(candidates), 'plus', e => run(e.currentTarget, container.querySelector('.out'), add), 'btn-primary')],
  });
}

// D'où vient la réception : la personne et son document (en lien, voir sourceLine), lien public, sens de l'Échange.
function cardOrigin({ note, public: isPublic }) {
  return [
    sourceLine(note.from, { verified: note.mode === 'echange', origin: here }),
    isPublic ? el('p', { class: 'muted small' }, t('recv.public')) : null,
    note.mode === 'echange' ? el('p', { class: 'muted small' }, t(note.retour ? 'recv.exchange.back' : 'recv.exchange')) : null,
  ];
}

// « Coller le lien » de la réception, ou « Continuer » tant qu'il manque.
const linkButton = group => button(t(group.waiting ? 'recv.action.continue' : 'recv.action.link'), 'link',
  () => receiveWizard(group, renderTarget), group.waiting ? 'btn-primary' : '');

// Réception dont le journal a été supprimé (voir lost.js) : le widget n'a plus de note, mais le partage du
// formulaire dit encore ce qui existait. Seul un propriétaire retire l'avis (et avec lui l'ancienne clé
// d'écriture).
function lostCard(lost, owner) {
  const list = there => lost.dests.filter(d => d.there === there).map(d => d.dest);
  const [gone, kept] = [list(false), list(true)];
  const clean = async () => {
    await dismissLost(lost);
    lostList = lostList.filter(l => l !== lost);
    await renderTarget();
  };
  return el('article', { class: 'card', 'data-lost-reception': lost.journal },
    el('div', { class: 'card-head' }, el('strong', {}, t('recv.lost.title', { name: lost.name || lost.journal })), pill(t('recv.status.error'), 'err')),
    el('p', { class: 'small' }, t('recv.lost.body', { journal: lost.journal })),
    gone.length ? el('p', { class: 'small' }, t('recv.lost.gone', { list: gone.join(', '), n: gone.length })) : null,
    kept.length ? el('p', { class: 'small' }, t('recv.lost.kept', { list: kept.join(', '), n: kept.length })) : null,
    el('p', { class: 'small' }, t('recv.lost.effect')),
    el('p', { class: 'small' }, t('recv.lost.how')),
    el('div', { class: 'card-actions' }, owner
      ? button(t('recv.lost.clean'), 'trash', e => run(e.currentTarget, container.querySelector('.out'), clean), 'btn-danger-text')
      : el('span', { class: 'muted small' }, t('recv.lost.owner'))));
}

// Une carte qui ne peut pas se dessiner (journal abîmé) n'empêche pas les autres de l'être : elle
// garde son nom, l'erreur, et de quoi couper le lien ou arrêter la réception.
function safeCard(group) {
  try {
    return syncCard(group);
  } catch (e) {
    console.error(e);
    noteError(e);
    return el('article', { class: 'card', 'data-journal': group.journal },
      el('div', { class: 'card-head' }, el('strong', {}, String(group.note.name || group.journal)), pill(t('recv.status.error'), 'err')),
      message('err', errorText(e)),
      el('div', { class: 'card-actions' },
        group.public ? null : button(t('recv.suspect.cut'), 'unlink', () => cutLink(group), 'btn-danger-text'),
        button(t('recv.action.stop'), 'stop', () => stopReceiving(group), 'btn-danger-text')));
  }
}

const alertBlock = (title, lines, actions) => notice({ tone: 'warn', className: 'suspect', title, lines, actions });

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
  ], [button(t('recv.suspect.cut'), 'unlink', () => cutLink(group), 'btn-danger-text'), button(t('recv.suspect.dismiss'), 'ignore', dismiss)]);
}

// Couper le lien : le formulaire de cette réception prend une nouvelle clé, sur sa propre page. La
// SOURCE révoque l'ancien destinataire et envoie une nouvelle invitation, acceptée ici sur la même
// réception.
async function cutLink(group) {
  if (!(await confirmDialog({ title: t('recv.cut.title'), body: t('recv.cut.body'), confirmLabel: t('recv.suspect.cut') }))) return;
  await updateJournalNote(group.journal, ({ suspect, ...note }) => note);
  await renewFormLink(group.journal);
  flash = { node: message('ok', t('recv.cut.done')), until: Date.now() + NOTICE_MS };
  await renderTarget();
}

// Effacer l'historique de la réception et nettoyer son journal, sur demande seulement et après confirmation
// (voir engine/target/clean.js : l'avant des modifications et les valeurs des lignes supprimées à la SOURCE sont vidés).
async function cleanReception(group) {
  const body = [el('p', {}, t('recv.clean.body')), el('p', { class: 'muted small' }, t('recv.clean.limits'))];
  if (!(await confirmDialog({ title: t('recv.clean.title', { name: group.note.name }), body, confirmLabel: t('recv.clean.confirm') }))) return;
  const done = await cleanJournal(group.journal);
  state.results.clear();
  await consolidateAll();
  if (done) flash = { node: message('ok', t('recv.clean.done', done)), until: Date.now() + NOTICE_MS };
  await renderTarget();
}

// Arrêter de recevoir : efface le journal (et son formulaire, donc la clé d'écriture) ; les tables
// de destination et leurs lignes restent. Un Échange s'arrête dans les deux sens (voir closeExport).
async function stopReceiving(group) {
  const { note } = group;
  const exchange = note.mode === 'echange';
  const body = t(exchange ? 'send.revoke.exchange' : 'recv.stop.body', { journal: group.journal });
  if (!(await confirmDialog({ title: t('recv.stop.title', { name: note.name }), body, confirmLabel: t('recv.action.stop') }))) return;
  if (exchange) await closeExport(note.export, { keepExport: Boolean(note.retour) });
  else await removeTechnicalTables([group.journal]);
  forgetJournal(group.journal);
  await renderTarget();
}

// ---------------------------------------------------------------------------------------------
// Valeurs en petit tableau, comme dans une vue Grist.

// Texte d'une valeur reçue ou lue dans la destination : liste de choix, date, case à cocher,
// pièces jointes (noms des fichiers reçus, ou nombre de fichiers ici).
function cellText(value, type = '') {
  if (type === 'Attachments' && Array.isArray(value)) return filesText(value);
  if (Array.isArray(value)) return value[0] === 'L' ? value.slice(1).join(', ') : JSON.stringify(value);
  if (typeof value === 'boolean') return t(value ? 'common.yes' : 'common.no');
  if (typeof value === 'number' && /^Date/.test(type)) return dateCell(value, type);
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
}

// Pièces jointes : noms des fichiers reçus, ou nombre de fichiers ici.
function filesText(value) {
  const files = fileList(value);
  return files.length ? files.map(file => file.name).join(', ') : t('recv.files.count', { n: value.length - (value[0] === 'L' ? 1 : 0) });
}

// Date (en UTC, comme Grist la garde) ou date et heure dans le fuseau de la colonne ; un fuseau
// inconnu donne la valeur brute.
function dateCell(value, type) {
  const zone = type.startsWith('DateTime:') ? type.slice(9) : 'UTC';
  try {
    const date = new Date(value * 1000);
    return type.startsWith('DateTime') ? date.toLocaleString(LANG, { timeZone: zone }) : date.toLocaleDateString(LANG, { timeZone: 'UTC' });
  } catch (e) {
    return String(value);
  }
}

const cell = (value, type, kind = '') => {
  if (isBlank(value)) return el('td', { class: `${kind} mg-blank` }, t('common.blank'));
  const text = cellText(value, type);
  return el('td', { class: kind, title: text }, text);
};

// Valeurs d'une ligne avant ou après un changement (`kind`), sous l'intitulé `heading`.
const valuesRow = (kind, heading, values, typesOf) => el('tr', { class: `mg-${kind}` }, el('th', { scope: 'row' }, heading),
  values.map((v, i) => cell(v, typesOf(i))));

// Tête d'un changement (historique, changement à valider) : numéro de ligne, icône, nom, état.
const changeHead = ({ n, state: change, label }, nTitle = null) => [
  el('span', { class: 'chg-n', title: nTitle }, n ? String(n) : ''),
  el('span', { class: 'chg-dot', title: t(`recv.history.${change}`) }, icon(STATE_ICON[change])),
  el('span', { class: 'chg-label' }, label || '—'),
  el('span', { class: 'chg-state' }, t(`recv.history.${change}`))];

const miniGrid = (head, rows) => el('div', { class: 'mini-grid-wrap' }, el('table', { class: 'mini-grid' },
  el('thead', {}, el('tr', {}, head.map(h => el('th', { scope: 'col' }, h)))), el('tbody', {}, rows)));

// Écarts en petit tableau (retouches faites ici, écarts laissés par un refus), une ligne de tableau
// par cellule, SHOWN au plus. `lines` : [{ n, label, cells: [[colonne reçue, colonne d'ici,
// valeur d'ici, autre valeur]] }], ou une phrase (`said`) pour une ligne entière, ou pour une
// colonne entière (`col`). Rend le tableau et ce qu'il montre : lignes de tableau (`rows`) et
// lignes d'écart (`lines`), pour dire combien restent.
function diffGrid(lines, { types = {}, labelCol = '', otherHead }) {
  const said = (text, span) => el('td', { class: 'mg-here', colspan: String(span) }, text);
  const head = l => [el('td', { class: 'mg-n' }, l.n ? String(l.n) : ''), el('td', { title: l.label }, l.label)];
  const all = lines.flatMap((l, i) => {
    if (l.col) return [[i, el('tr', {}, el('td', {}), el('td', {}), el('td', {}, l.col), said(l.said, 2))]];
    if (l.said) return [[i, el('tr', {}, head(l), said(l.said, 3))]];
    return l.cells.map(([from, to, here, other]) => [i, el('tr', {}, head(l), el('td', {}, to), cell(here, types[from], 'mg-here'), cell(other, types[from], 'mg-source'))]);
  });
  const shown = all.slice(0, SHOWN);
  const columns = [t('recv.drift.row'), labelCol, t('recv.drift.col'), t('recv.drift.here'), otherHead];
  return { grid: miniGrid(columns, shown.map(([, tr]) => tr)), rows: shown.length, lines: new Set(shown.map(([i]) => i)).size };
}

const more = n => (n > 0 ? el('p', { class: 'small' }, t('recv.history.more', { n })) : null);

// Au-delà de FOLD_FROM retouches, le détail se replie (il reste ouvert d'un dessin à l'autre, comme l'historique).
const FOLD_FROM = 5;
const fold = (id, summary, content) => el('details', { class: 'fold', open: opened.has(id), ontoggle: keepOpen(id) }, el('summary', {}, summary), content);

// Retouches faites à la main dans une destination : colonnes reçues effacées, cellules qui
// diffèrent de la dernière version reçue (avec leur numéro de ligne), lignes reçues effacées. Elles
// restent jusqu'à ce que la SOURCE change leur ligne, ou que l'on clique sur « Corriger ». Le
// compte est celui des retouches (une par cellule, ligne ou colonne).
function driftBlock(group, entry) {
  const result = state.results.get(tableKey(group.journal, entry.table)) || {};
  const total = result.driftCount || 0;
  if (!total) return null;
  const lines = [
    ...(result.droppedCols || []).map(([, to]) => ({ col: to, said: t('recv.drift.colGone') })),
    ...(result.drift || []).map(d => (d.gone ? { label: d.label, said: t('recv.drift.rowGone') } : d)),
  ];
  const { grid, rows } = diffGrid(lines, { types: result.types, labelCol: result.labelCol, otherHead: t('recv.drift.source') });
  const detail = [grid, more(total - rows)];
  return notice({
    tone: 'info', className: 'drift', title: t('recv.drift.title', { dest: entry.dest, n: total }), lines: [t('recv.drift.body', { n: total })],
    body: total > FOLD_FROM ? fold(`drift:${group.journal}:${entry.table}`, t('recv.drift.show', { n: total }), detail) : detail,
    actions: [button(t('recv.drift.fix'), 'undo', e => run(e.currentTarget, container.querySelector('.out'), () => correct(group, entry, result)))],
  });
}

// Références (et Listes de références) que la SOURCE garde (voir links.js) : celles qui sont refaites ici, et celles restées du texte
// parce que la colonne contenait déjà du texte reçu avant que la SOURCE en garde le lien. Le widget n'y touche pas sans accord :
// un propriétaire clique « Refaire les références », après une fenêtre qui dit ce qui change.
function linksBlock(group, entry) {
  const result = state.results.get(tableKey(group.journal, entry.table)) || {};
  const made = (result.links || []).map(s => ({ ...s, name: `${entry.dest}.${s.to}` }));
  const text = (result.relinkable || []).map(s => ({ ...s, name: `${entry.dest}.${s.to}` }));
  const done = made.length ? notice({ tone: 'ok', className: 'links-done', title: t('recv.links.done'), lines: [made.map(s => t('recv.links.item', { name: s.name, target: s.target })).join(' · ')] }) : null;
  if (!text.length) return done;
  return [done, notice({
    tone: 'warn', className: 'links-text', title: t('recv.relink.title', { n: text.length, name: text.map(s => s.name).join(', ') }), lines: [t('recv.relink.body', { n: text.length }),
      group.owner ? '' : t('recv.relink.owner')],
    actions: group.owner ? [button(t('recv.relink.button'), 'column', e => run(e.currentTarget, container.querySelector('.out'), () => relinkReception(group, entry, text)))] : [],
  })];
}

// « Refaire les références » : après confirmation, les colonnes restées du texte deviennent des Références (Listes de références),
// leurs cellules reprennent le lien envoyé par la SOURCE.
async function relinkReception(group, entry, text) {
  const body = [
    el('ul', {}, text.map(s => el('li', {}, t(s.list ? 'recv.relink.item.list' : 'recv.relink.item', { name: s.name, target: s.target })))),
    el('p', {}, t('recv.relink.body2')),
  ];
  if (!(await confirmDialog({ title: t('recv.relink.confirmTitle', { name: group.note.name }), body, confirmLabel: t('recv.relink.button'), kind: 'btn-primary' }))) return;
  await relink(group.journal);
  flash = { node: message('ok', t('recv.relink.done', { cols: text.map(s => s.name).join(', ') })), until: Date.now() + NOTICE_MS };
  await renderTarget();
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
// Échange administré ici : changements d'un participant à valider, puis écarts laissés par un refus.

// Chaque changement à valider montre ce qu'il changerait ici (valeur d'ici, valeur proposée) et a
// ses deux boutons ; « Tout accepter » et « Tout refuser » valent aussi pour ceux que la carte ne
// montre pas, après confirmation. Rien n'est écrit ici avant la décision.
function reviewBlock(group, entry) {
  const result = state.results.get(tableKey(group.journal, entry.table)) || {};
  const total = result.pendingCount || 0;
  if (!total) return null;
  const types = result.types || {};
  const out = () => container.querySelector('.out');
  const choose = async (e, ids, choice) => run(e.currentTarget, out(), async () => {
    await decide(group.journal, ids, choice);
    await renderTarget();
  });
  const all = async (e, choice) => {
    const target = e.currentTarget;
    const label = t(`recv.review.${choice}All`);
    if (await confirmDialog({ title: label, body: t(`recv.review.${choice}AllBody`, { n: total }), confirmLabel: label })) await choose({ currentTarget: target }, result.pendingIds, choice);
  };
  const values = (kind, cells, at) => valuesRow(kind, t(`recv.review.${kind === 'before' ? 'here' : 'proposed'}`), cells.map(c => c[at]), i => types[cells[i][0]]);
  const items = result.pending.slice(0, SHOWN).map(p => el('li', { class: `review-item chg-${p.state}` },
    el('div', { class: 'review-head' },
      changeHead(p),
      el('span', { class: 'review-actions' },
        button(t('recv.review.accept'), 'check', e => choose(e, [p.id], 'accepter')),
        button(t('recv.review.refuse'), 'refuse', e => choose(e, [p.id], 'refuser'), 'btn-danger-text'))),
    p.cells.length ? miniGrid(['', ...p.cells.map(([, to]) => to)], [
      p.state === 'ajout' ? null : values('before', p.cells, 2),
      p.state === 'suppression' ? null : values('after', p.cells, 3)].filter(Boolean)) : null));
  return notice({
    tone: 'warn', className: 'review', title: t('recv.review.title', { dest: entry.dest, n: total }), lines: [t('recv.review.body')],
    body: [el('ul', { class: 'review-rows' }, items), more(total - items.length)],
    actions: [button(t('recv.review.accepterAll'), 'check', e => all(e, 'accepter')), button(t('recv.review.refuserAll'), 'refuse', e => all(e, 'refuser'), 'btn-danger-text')],
  });
}

// Refus avec écart signalé : la ligne refusée reste différente chez le participant, jusqu'à la
// prochaine modification de la ligne, ici ou chez lui.
// Le compte est celui des lignes refusées.
function gapBlock(group, entry) {
  const result = state.results.get(tableKey(group.journal, entry.table)) || {};
  const total = result.gapCount || 0;
  if (!total) return null;
  const lines = result.gaps.map(g => (g.state !== 'modif' || !g.cells.length ? { n: g.n, label: g.label, said: t(`recv.gap.${g.state}`) } : g));
  const { grid, lines: shown } = diffGrid(lines, { types: result.types, labelCol: result.labelCol, otherHead: t('recv.gap.theirs') });
  return notice({ tone: 'info', className: 'drift', title: t('recv.gap.title', { dest: entry.dest, n: total }), lines: [t('recv.gap.body')], body: [grid, more(total - shown)] });
}

// ---------------------------------------------------------------------------------------------
// Historique : lignes changées depuis la visite précédente, par table de destination : compteurs
// par état (ajoutées, modifiées, supprimées, et colonnes ajoutées par la SOURCE), puis les plus
// récentes (HISTORY_MAX par table), numérotées comme dans la table et nommées par la colonne
// choisie pour chaque table. Chacune s'ouvre au clic sur son avant et son après. Tout est replié
// par défaut.

const STATE_ICON = { ajout: 'plus', modif: 'edit', suppression: 'minus', colonne: 'column', [REFUSED]: 'refuse' };
const COUNTED = [...STATES, 'colonne', REFUSED];

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
  const label = c.state === 'colonne' ? t('recv.history.colLabel', { col: c.label }) : c.label;
  const line = [
    changeHead({ ...c, label }, c.n ? t(gone ? 'recv.history.rowGone' : 'recv.history.row', { n: c.n }) : null),
    el('time', { class: 'chg-time', datetime: new Date(c.at * 1000).toISOString() }, when(c.at))];
  const rowClass = `chg-row chg-${c.state}`;
  if (!c.detail) return el('li', { class: `chg-item chg-${c.state}` }, el('div', { class: rowClass }, line));
  const { cols, before, after } = c.detail;
  // Un refus montre ce qui est gardé ici et ce qui était proposé.
  const heading = kind => (c.state === REFUSED ? t(`recv.review.${kind === 'before' ? 'here' : 'proposed'}`) : t(`recv.history.${kind}`));
  const values = (kind, list) => list && valuesRow(kind, heading(kind), list, i => types[cols[i][0]]);
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
  const chosen = () => JSON.stringify(pickers.map(p => p.field.value()));
  const initial = chosen();
  const saveHere = m => run(null, report, () => save(m));
  openModal({
    title: t('recv.label.title'), width: 400,
    body: [el('p', { class: 'small' }, t('recv.label.help')), ...pickers.map(p => el('div', { class: 'dest-row' }, el('span', {}, p.entry.dest), p.field)), report],
    guard: { save: saveHere, changed: () => chosen() !== initial },
    buttons: [cancelButton(), { label: t('common.save'), kind: 'btn-primary', onClick: saveHere }],
  });
}
