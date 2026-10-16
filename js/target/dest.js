// CIBLE : destination d'une table reçue, nouvelle (nom libre) ou existante (liste filtrable). Une
// table existante passe ensuite par la correspondance des colonnes et le rattachement des lignes.
// Aussi : la fenêtre d'une table que la SOURCE ajoute à un export déjà reçu.
import { EXPORT_COL, KEY_COL, TABLE_COL, isUserTable, toTableId } from '../logic/common.js';
import { docIdentity, readSchema } from '../grist.js';
import { syncRows } from '../source/synchro.js';
import { wireExchange } from '../exchange.js';
import { destColumns, prepareDest, receivedDests, receivedJournals, updateJournalNote } from './journals.js';
import { consolidateAll } from './loop.js';
import { confirmDialog, el, message, openModal, pickField, run } from '../ui.js';
import { stepHelp } from '../tutorial.js';
import { t } from '../i18n.js';

// Choix de la destination d'une table. `dest()` rend son nom : une table existante, ou le nom
// tapé (un nom qui est celui d'une table existante, aux majuscules près, désigne cette table).
export function destField(schema, table) {
  const tables = schema.tableIds.filter(isUserTable);
  const name = el('input', { type: 'text', class: 'input', value: toTableId(table), 'aria-label': t('recv.dest.name', { table }) });
  const field = pickField({
    label: table, value: '',
    items: [{ value: '', label: t('recv.dest.new') }, ...tables.map(id => ({ value: id, label: id }))],
    onChange: (v) => { name.classList.toggle('hidden', v !== ''); },
  });
  const typed = () => toTableId(name.value, table);
  return { node: el('div', {}, field, name), dest: () => field.value() || schema.resolve(typed()) || typed() };
}

// Colonne qui reçoit chaque colonne envoyée (la même, une autre, ou une nouvelle), et colonne
// commune qui rattache les lignes déjà là au lieu de les doubler. `read()` rend { map, match }.
export function mappingBlock(schema, table, dest, columns) {
  const destCols = schema.columns(dest).filter(c => !c.isFormula && c.colId !== KEY_COL).map(c => c.colId);
  const maps = destColumns(columns).map(c => ({
    id: c.id,
    field: pickField({
      label: c.id, value: destCols.includes(c.id) ? c.id : '',
      items: [...(destCols.includes(c.id) ? [] : [{ value: '', label: t('recv.col.new', { col: c.id }) }]), ...destCols.map(d => ({ value: d, label: d }))],
    }),
  }));
  const match = pickField({
    label: t('recv.match'), value: '',
    items: [{ value: '', label: t('recv.match.none') }, ...destCols.map(d => ({ value: d, label: d }))],
  });
  const node = el('div', { class: 'form' },
    el('h3', {}, `${table} → ${dest}`),
    ...maps.map(m => el('div', { class: 'dest-row' }, el('span', {}, `${m.id} →`), m.field)),
    el('label', {}, t('recv.match')), match,
    el('p', { class: 'muted small' }, t('recv.match.help')));
  const read = () => {
    const map = Object.fromEntries(maps.map(m => [m.id, m.field.value() || m.id]));
    const targets = Object.values(map);
    if (new Set(targets).size !== targets.length) throw new Error('mapTwice');
    if (match.value() && !targets.includes(match.value())) throw new Error('matchUnmapped');
    return { map, match: match.value() };
  };
  return { node, read };
}

// Une destination ne reçoit qu'une table, d'un seul export, et n'est ni une table du widget, ni
// une table que ce document envoie lui-même (ses lignes, absentes des listes de la SOURCE, y
// seraient effacées ; le relais, lui, reçoit d'abord puis envoie). Copie dans le même document :
// une table ne peut pas se recevoir elle-même (`plans` : [{ table, dest }]). Échange (`exportId`) :
// une table que ce document envoie dans le même Échange peut recevoir.
export async function checkDests(schema, plans, fromDocId, exportId = null) {
  const taken = receivedDests(schema).map(d => d.dest);
  const dests = plans.map(p => p.dest);
  if (new Set(dests).size !== dests.length || dests.some(d => taken.includes(d) || !isUserTable(d))) throw new Error('destTaken');
  const sent = new Set((await syncRows(schema)).filter(r => !exportId || r[EXPORT_COL] !== exportId).map(r => r[TABLE_COL]));
  if (dests.some(d => sent.has(d))) throw new Error('destExported');
  if (fromDocId && fromDocId === (await docIdentity()).docId && plans.some(p => p.dest === p.table)) throw new Error('loop');
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
  const accept = async (entry, m) => {
    await prepareDest({ dest: entry.dest, columns: offer.columns, map: entry.map });
    // Deux éditeurs qui rangent la même table : la première réponse compte.
    await updateJournalNote(group.journal, note => (note.tables.some(tb => tb.table === entry.table) ? note : { ...note, tables: [...note.tables, entry] }));
    // Échange, côté CIBLE : la table rangée repart aussi vers la SOURCE.
    if (exchange && !group.note.retour) await wireExchange(receivedJournals(await readSchema()).find(r => r.journal === group.journal).note);
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
    const entry = { table: offer.table, dest, columns: offer.columns };
    if (!schema.has(dest)) return accept(entry, m);
    const mapping = mappingBlock(schema, offer.table, dest, offer.columns);
    step.replaceChildren(el('p', {}, t('recv.existing')), mapping.node);
    m.setButtons([{ label: t('common.back'), onClick: () => { step.replaceChildren(first); m.setButtons(buttons); } },
      { label: t('recv.offer.accept'), kind: 'btn-primary', onClick: mm => run(null, report, () => {
        const { map, match } = mapping.read();
        return accept({ ...entry, map, ...(match ? { match } : {}) }, mm);
      }) }]);
    return null;
  };
  const first = el('div', { class: 'form' },
    message('info', t('recv.offer.body', { name: group.note.name, table: offer.table, n: offer.n, cols: offer.columns.map(c => c.id).join(', ') })),
    el('label', {}, t('recv.offer.where')), pick.node, stepHelp(['t-offer']));
  step.replaceChildren(first);
  const buttons = [
    { label: t('common.later') },
    { label: t('recv.offer.refuse'), kind: 'btn-danger-text', onClick: m => run(null, report, () => refuse(m)) },
    { label: t('recv.offer.accept'), kind: 'btn-primary', onClick: m => run(null, report, () => choose(m)) },
  ];
  openModal({ title: t('recv.offer.title', { table: offer.table }), body: [step, report], buttons });
}
