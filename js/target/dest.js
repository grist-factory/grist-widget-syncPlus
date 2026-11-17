// CIBLE : destination d'une table reçue, nouvelle (nom libre) ou existante (liste filtrable). Une
// table existante passe ensuite par la correspondance des colonnes et le rattachement des lignes.
// Aussi : la fenêtre d'une table que la SOURCE ajoute à un export déjà reçu.
import { KEY_COL, destTableId, isUserTable } from '../engine/logic/common.js';
import { isOwner, readSchema } from '../grist.js';
import { exportSchema } from '../engine/logic/codes.js';
import { exportableColumns } from '../engine/logic/exports.js';
import { wireExchange } from '../engine/exchange.js';
import { destColumns } from '../engine/logic/journal.js';
import { fitIssues } from '../engine/logic/adopt.js';
import { checkDests } from '../engine/target/dest.js';
import { prepareDest, storeKey, updateJournalNote } from '../engine/target/journals.js';
import { keySlot, missingColumns, receivedDests, receivedJournals, receivedKey } from '../engine/logic/received.js';
import { consolidateAll } from '../engine/target/loop.js';
import { backButton, confirmDialog, el, laterButton, message, openModal, pickField, run, withHelp } from '../ui.js';
import { stepHelp } from '../tutorial.js';
import { t, typeName } from '../i18n.js';

// Choix de la destination d'une table. `dest()` rend son nom : une table existante, ou le nom
// tapé (un nom qui est celui d'une table existante, aux majuscules près, désigne cette table). Une
// table qui reçoit déjà une synchro le dit dans la liste (elle sera refusée, voir checkDests).
export function destField(schema, table) {
  const tables = schema.tableIds.filter(isUserTable);
  const feeds = new Map(receivedDests(schema).map(r => [r.dest, r.table]));
  const label = id => (feeds.has(id) ? t('recv.dest.taken', { dest: id, table: feeds.get(id) }) : id);
  const name = el('input', { type: 'text', class: 'input', value: destTableId(table), 'aria-label': t('recv.dest.name', { table }) });
  const nameBox = el('div', { class: 'dest-pick' }, el('span', { class: 'muted small' }, t('recv.dest.nameLabel')), name);
  const field = pickField({
    label: table, value: '',
    items: [{ value: '', label: t('recv.dest.new') }, ...tables.map(id => ({ value: id, label: label(id) }))],
    onChange: (v) => { nameBox.classList.toggle('hidden', v !== ''); },
  });
  const typed = () => destTableId(name.value, table);
  return { node: el('div', { class: 'dest-pick' }, field, nameBox), dest: () => field.value() || schema.resolve(typed()) || typed() };
}

// Colonne qui reçoit chaque colonne envoyée (la même, une autre, ou une nouvelle), et colonne
// commune qui rattache les lignes déjà là au lieu de les doubler. `read()` rend { map, match } ;
// `issues()` : les colonnes d'ici dont le type ne convient pas à ce qui est envoyé (voir fitIssues), dites
// sous les champs à mesure que la personne choisit, et à confirmer avant de continuer (`confirmFit`).
export function mappingBlock(schema, table, dest, columns) {
  const hereCols = schema.columns(dest);
  const destCols = hereCols.filter(c => !c.isFormula && c.colId !== KEY_COL).map(c => c.colId);
  const notes = el('div', { class: 'fit-notes' });
  const refresh = () => notes.replaceChildren(...fitIssues(columns, mapNow(), hereCols).map(issue => el('p', {
    class: `small msg msg-${issue.level === 'bad' ? 'err' : 'warn'}`, role: 'status',
  }, fitText(issue))));
  const maps = destColumns(columns).map(c => ({
    id: c.id,
    field: pickField({
      label: c.id, value: destCols.includes(c.id) ? c.id : '',
      items: [...(destCols.includes(c.id) ? [] : [{ value: '', label: t('recv.col.new', { col: c.id }) }]), ...destCols.map(d => ({ value: d, label: d }))],
      onChange: refresh,
    }),
  }));
  const mapNow = () => Object.fromEntries(maps.map(m => [m.id, m.field.value() || m.id]));
  const match = pickField({
    label: t('recv.match'), value: '',
    items: [{ value: '', label: t('recv.match.none') }, ...destCols.map(d => ({ value: d, label: d }))],
  });
  refresh();
  const node = el('div', { class: 'form' },
    el('h3', {}, `${table} → ${dest}`),
    ...maps.map(m => el('div', { class: 'dest-row' }, el('span', {}, `${m.id} →`), m.field)),
    notes,
    withHelp(el('label', {}, t('recv.match')), t('recv.match.help')), match);
  const read = () => {
    const map = mapNow();
    const targets = Object.values(map);
    if (new Set(targets).size !== targets.length) throw new Error('mapTwice');
    if (match.value() && !targets.includes(match.value())) throw new Error('matchUnmapped');
    return { map, match: match.value() };
  };
  return { node, read, issues: () => fitIssues(columns, mapNow(), hereCols) };
}

const fitText = issue => t(`recv.fit.${issue.level}`, { col: issue.id, to: issue.to, sent: typeName(issue.sent), here: typeName(issue.here) });

// Types qui ne correspondent pas (voir fitIssues) : rien ne se fait sans que la personne le sache. Rend vrai si elle continue.
export async function confirmFit(issues) {
  if (!issues.length) return true;
  return confirmDialog({
    title: t('recv.fit.title'), body: [el('p', {}, t('recv.fit.body')), el('ul', { class: 'small' }, ...issues.map(issue => el('li', {}, fitText(issue))))],
    confirmLabel: t('recv.fit.ok'),
  });
}

// Table qui n'existe pas encore (`dests`) : le widget la crée, avec sa propre page, et n'y est pas. Il ne
// recopie que page ouverte : qui n'ouvre que cette table ne reçoit rien de nouveau. La personne peut
// créer la table d'abord et y poser le widget, ou continuer et poser le widget ensuite sur sa page.
// Rend vrai si elle continue.
export function confirmNewTables(dests) {
  return confirmDialog({
    title: t('recv.new.title'),
    body: [el('p', {}, t('recv.new.body', { tables: dests.join(', '), n: dests.length })), el('p', {}, t('recv.new.safe')), el('p', {}, t('recv.new.after'))],
    confirmLabel: t('recv.new.ok'), kind: 'btn-primary',
  });
}

// Échange rangé dans des tables existantes (`dests`) : toutes leurs colonnes partiront vers l'autre
// document (voir wireExchange), y compris celles que l'export ne reçoit pas. La personne le
// confirme, colonnes nommées ; `where` : le document qui les recevra.
export async function confirmOutgoing(schema, dests, where) {
  const existing = dests.filter(d => schema.has(d));
  if (!existing.length) return true;
  const list = existing.map(d => `${d} (${exportableColumns(schema.columns(d) || []).map(c => c.id).join(', ')})`).join(' ; ');
  return confirmDialog({ title: t('recv.outgoing.title'), body: t('recv.outgoing.body', { list, where }), confirmLabel: t('recv.outgoing.ok') });
}

// ---------------------------------------------------------------------------------------------
// Table ajoutée par la SOURCE à un export reçu : la ranger (nouvelle table ou existante), la
// refuser (ses lignes sont effacées du journal à mesure qu'elles arrivent), ou plus tard.
// `onDone` : appelé une fois la table rangée ou refusée (l'onglet se redessine).

export async function offerDialog(group, offer, onDone) {
  const schema = await readSchema();
  const pick = destField(schema, offer.table);
  const report = el('div', { class: 'report' });
  const step = el('div', { class: 'form' });
  const exchange = group.note.mode === 'echange';
  const finish = async (m) => {
    m.close();
    await consolidateAll();
    await onDone();
  };
  const accept = async (picked, m) => {
    const before = await readSchema();
    // Réception qui demande l'accord, table qui existait : sa première recopie attend un aperçu (voir adopt.js).
    const entry = { ...picked, own: missingColumns(before, picked.dest, offer.columns, picked.map || {}), ...(group.note.ask && !exchange && before.has(picked.dest) ? { adopt: true } : {}) };
    await prepareDest({ dest: entry.dest, columns: offer.columns, map: entry.map });
    await storeKey([entry.dest], keySlot(group.journal, group.note), receivedKey(await readSchema(), group.journal, group.note));
    // Deux éditeurs qui rangent la même table : la première réponse compte.
    await updateJournalNote(group.journal, note => (note.tables.some(tb => tb.table === entry.table) ? note : { ...note, tables: [...note.tables, entry] }));
    // Échange, côté CIBLE : la table rangée repart aussi vers la SOURCE (par un propriétaire : le
    // passage d'un propriétaire le fera sinon, voir followExchange).
    if (exchange && !group.note.retour && await isOwner()) await wireExchange(receivedJournals(await readSchema()).find(r => r.journal === group.journal).note);
    await finish(m);
  };
  const refuse = async (m) => {
    if (!(await confirmDialog({ title: t('recv.offer.refuseTitle', { table: offer.table }), body: t('recv.offer.refuseBody'), confirmLabel: t('recv.offer.refuse') }))) return;
    await updateJournalNote(group.journal, note => ({ ...note, refused: [...(note.refused || []), offer.table] }));
    await finish(m);
  };
  // Table existante : correspondance des colonnes avant de ranger.
  const choose = async (m) => {
    const dest = pick.dest();
    await checkDests(schema, [{ table: offer.table, dest }], (group.note.from || {}).docId, exchange ? group.note.export : null);
    // La note du journal (lisible avec la clé du formulaire tant qu'il n'est pas réservé) ne garde
    // ni les listes de choix ni les liens des colonnes : ils restent dans les lots reçus.
    const entry = { table: offer.table, dest, columns: exportSchema(offer.columns) };
    if (!schema.has(dest)) return (await confirmNewTables([dest])) ? accept(entry, m) : null;
    const from = group.note.from || {};
    if (exchange && !(await confirmOutgoing(schema, [dest], from.docName || from.docId || group.note.name))) return null;
    const mapping = mappingBlock(schema, offer.table, dest, offer.columns);
    step.replaceChildren(el('p', {}, t('recv.existing')), mapping.node);
    m.setButtons([backButton(() => { step.replaceChildren(first); m.setButtons(buttons); }),
      { label: t('recv.offer.accept'), kind: 'btn-primary', onClick: mm => run(null, report, () => {
        const { map, match } = mapping.read();
        return confirmFit(mapping.issues()).then(go => (go ? accept({ ...entry, map, ...(match ? { match } : {}) }, mm) : null));
      }) }]);
    return null;
  };
  const first = el('div', { class: 'form' },
    message('info', t('recv.offer.body', { name: group.note.name, table: offer.table, n: offer.n, cols: offer.columns.map(c => c.id).join(', ') })),
    el('label', {}, t('recv.offer.where')), pick.node, stepHelp(['t-offer']));
  step.replaceChildren(first);
  const buttons = [
    laterButton(),
    { label: t('recv.offer.refuse'), kind: 'btn-danger-text', onClick: m => run(null, report, () => refuse(m)) },
    { label: t('recv.offer.accept'), kind: 'btn-primary', onClick: m => run(null, report, () => choose(m)) },
  ];
  openModal({ title: t('recv.offer.title', { table: offer.table }), body: [step, report], buttons });
}
