// SOURCE : assistant d'export, en trois étapes (Tables, Colonnes, Nom). Crée l'export, ou le
// modifie (`exp`) : ajouter ou retirer des tables, changer les colonnes ou le nom vaut pour tous
// ses destinataires.
import { SYNC_TABLE, isUserTable, randomHex } from '../logic/common.js';
import { exportableColumns, hookName } from '../logic/exports.js';
import { fillKeyActions, missingSyncColumns, prepareSourceActions } from '../logic/formulas.js';
import { apply, fetchRows, readSchema, renameWebhook } from '../grist.js';
import { saveExport, updateSourceNote } from './synchro.js';
import { receivedDests } from '../target/journals.js';
import { resendTables } from './resend.js';
import { recipientWizard } from './recipient-wizard.js';
import { checkList, el, message, openWizard, pickField, run } from '../ui.js';
import { roleGuide } from '../guide.js';
import { stepHelp } from '../tutorial.js';
import { t, typeName } from '../i18n.js';

const cancel = { label: t('common.cancel') };
const columnLabel = c => (c.label === c.id ? c.id : `${c.label} (${c.id})`);

// `onClose` : appelé à la fermeture (l'onglet se redessine).
export function exportWizard(exp, onClose) {
  const wizard = openWizard({
    title: exp ? t('send.edit.title', { name: exp.name }) : t('send.new'),
    steps: ['send.step.tables', 'send.step.columns', 'send.step.name'].map(k => t(k)),
    onClose,
  });
  showTables({
    exp, wizard, onClose,
    chosen: exp ? exp.tables.map(tb => tb.table) : [],
    selected: new Map(exp ? exp.tables.map(tb => [tb.table, tb.columns.map(c => c.id)]) : []), // table -> colonnes cochées
    filters: new Map(exp ? exp.tables.map(tb => [tb.table, tb.filter]) : []), // table -> filtre de lignes, ou null
  });
}

// 1. Tables de l'export. Une table introuvable (renommée, effacée) en sort.
async function showTables(ctx) {
  const tables = (await readSchema()).tableIds.filter(isUserTable);
  ctx.chosen = ctx.chosen.filter(table => tables.includes(table));
  const report = el('div', { class: 'report' });
  const next = { label: t('common.next'), kind: 'btn-primary', disabled: !ctx.chosen.length, onClick: () => run(null, report, () => showColumns(ctx)) };
  const list = checkList({
    items: tables.map(id => ({ value: id, label: id })), checked: ctx.chosen, label: t('send.step.tables'),
    onChange: (values) => { ctx.chosen = values; next.disabled = !values.length; ctx.wizard.buttons([cancel, next]); },
  });
  ctx.wizard.show(0, [el('p', {}, t(ctx.exp ? 'send.edit.tables' : 'send.tables.help')), list, report, stepHelp(['s-tables']),
    ctx.exp ? null : roleGuide({ you: 'source', current: 0 })], [cancel, next]);
}

// Bloc d'une table à l'étape Colonnes : ses colonnes (toutes par défaut) et son filtre de lignes.
function columnsBlock(ctx, schema, table, relayed) {
  const all = exportableColumns(schema.columns(table));
  const usable = all.filter(c => !c.blocked);
  if (!ctx.selected.has(table)) ctx.selected.set(table, usable.map(c => c.id));
  const blocked = all.filter(c => c.blocked).map(c => c.id);
  return el('div', { class: 'form' }, el('h3', {}, table),
    relayed ? message('info', t('send.columns.relay')) : null,
    checkList({ items: usable.map(c => ({ value: c.id, label: columnLabel(c), hint: typeName(c.source) })),
      checked: ctx.selected.get(table), label: table, onChange: (values) => { ctx.selected.set(table, values); } }),
    blocked.length ? el('p', { class: 'muted small' }, t('send.columns.blocked', { cols: blocked.join(', ') })) : null,
    filterField(table, usable, ctx.filters.get(table), (filter) => { ctx.filters.set(table, filter); }));
}

// 2. Colonnes, par table, et ce que le widget ajoutera pour la synchro.
async function showColumns(ctx) {
  const schema = await readSchema();
  const relays = receivedDests(schema).map(d => d.dest);
  const report = el('div', { class: 'report' });
  const blocks = ctx.chosen.map(table => columnsBlock(ctx, schema, table, relays.includes(table)));
  const adds = ctx.chosen.flatMap(table => missingSyncColumns(schema.columns(table)).map(col => `${table}.${col}`));
  if (!schema.has(SYNC_TABLE)) adds.push(t('send.check.sync'));
  const removed = ctx.exp ? ctx.exp.tables.map(tb => tb.table).filter(table => !ctx.chosen.includes(table)) : [];
  const next = () => {
    if (ctx.chosen.some(table => !(ctx.selected.get(table) || []).length)) throw new Error('noColumn');
    showName(ctx);
  };
  ctx.wizard.show(1, [el('p', {}, t('send.columns.help')),
    removed.length ? message('warn', t('send.edit.removed', { tables: removed.join(', ') })) : null,
    ...blocks,
    adds.length ? message('info', t('send.check.missing', { items: adds.join(', ') })) : null, report, stepHelp(['s-columns'])], [
    { label: t('common.back'), onClick: () => showTables(ctx) },
    { label: t('common.next'), kind: 'btn-primary', onClick: () => run(null, report, next) }]);
}

// 3. Nom, puis création (ou enregistrement) : c'est ici seulement que le widget écrit.
function showName(ctx) {
  const fallback = ctx.chosen.join(' + ');
  const nameInput = el('input', { type: 'text', class: 'input', id: 'gristsync-export-name', value: ctx.exp ? ctx.exp.name : fallback });
  const report = el('div', { class: 'report' });
  ctx.wizard.show(2, [el('label', { for: 'gristsync-export-name' }, t('send.name')), nameInput, el('p', { class: 'muted small' }, t('send.name.help')), report], [
    { label: t('common.back'), onClick: () => run(null, report, () => showColumns(ctx)) },
    { label: ctx.exp ? t('common.save') : t('send.create'), kind: 'btn-primary', onClick: () => run(null, report, () => save(ctx, nameInput.value.trim() || fallback, report)) }]);
}

// Tables prêtes à partir (id_sync, MajLe…) et leurs colonnes choisies. Une table reçue (relais)
// garde la clé de son document d'origine : une ligne ajoutée ici à la main reste sans clé, donc
// locale (avec une clé, la prochaine liste de l'origine, qui ne la connaît pas, l'effacerait).
// Un seul instantané suffit : chaque étape ne touche que sa table, et les colonnes que le widget
// ajoute ne sont pas envoyables.
async function prepareTables(ctx) {
  const schema = await readSchema();
  const relays = receivedDests(schema).map(d => d.dest);
  const tables = [];
  for (const table of ctx.chosen) {
    await apply(prepareSourceActions(table, missingSyncColumns(schema.columns(table))));
    if (!relays.includes(table)) await apply(fillKeyActions(table, await fetchRows(table), () => crypto.randomUUID()));
    const columns = exportableColumns(schema.columns(table)).filter(c => !c.blocked && ctx.selected.get(table).includes(c.id));
    tables.push({ table, columns, filter: ctx.filters.get(table) || null });
  }
  return tables;
}

async function save(ctx, name, report) {
  const { exp, wizard } = ctx;
  const tables = await prepareTables(ctx);
  const id = exp ? exp.id : randomHex(8);
  const changed = await saveExport(id, tables, { isPublic: Boolean(exp && exp.public), swap: Boolean(exp && exp.echange) });
  await updateSourceNote((note) => {
    const others = note.exports.filter(e => e.id !== id);
    note.exports = [...others, { ...(exp ? note.exports.find(e => e.id === id) : {}), id, name, at: exp ? exp.at : Date.now() / 1000 }];
  });
  if (!exp) {
    const created = { id, name, tables, recipients: [], invitations: [], public: false, email: '' };
    wizard.show(3, [message('ok', t('send.created', { name })), el('p', {}, t('send.created.next'))], [
      { label: t('common.later') },
      { label: t('send.action.addPerson'), kind: 'btn-primary', onClick: () => { wizard.close(); recipientWizard(created, null, ctx.onClose); } }]);
    return;
  }
  if (name !== exp.name) for (const h of exp.recipients) await renameWebhook(h.id, hookName(name, id));
  // Fenêtre fermée pendant le renvoi, qui continue : l'onglet se redessine à la fin.
  if (changed.length) wizard.show(3, [report, el('p', { class: 'muted small' }, t('send.load.background'))], [{ label: t('common.close'), kind: 'btn-primary' }]);
  const n = changed.length ? await resendTables(id, changed, report) : 0;
  if (changed.length && !report.isConnected) return ctx.onClose && ctx.onClose();
  const saved = n === null ? message('info', t('send.load.queued')) : message('ok', n ? t('send.edit.saved', { n }) : t('send.edit.savedNone'));
  return wizard.show(3, saved, [{ label: t('common.close'), kind: 'btn-primary' }]);
}

// Filtre de lignes d'une table, facultatif : une colonne et la valeur qu'ont les lignes envoyées.
// `onChange` reçoit le filtre ({ id, source, visible, value }), ou null pour toutes les lignes.
function filterField(table, columns, current, onChange) {
  const input = el('input', { type: 'text', class: 'input', value: current ? current.value : '', 'aria-label': t('send.filter.value', { table }) });
  const hint = el('p', { class: 'muted small' });
  const filter = () => {
    const column = columns.find(col => col.id === pick.value());
    return column ? { id: column.id, source: column.source, visible: column.visible, value: input.value } : null;
  };
  const show = (id) => {
    const column = columns.find(col => col.id === id);
    input.hidden = !column;
    hint.textContent = column ? t(column.source === 'Bool' ? 'send.filter.bool' : 'send.filter.help') : '';
    onChange(filter());
  };
  const pick = pickField({
    items: [{ value: '', label: t('send.filter.all') }, ...columns.map(c => ({ value: c.id, label: columnLabel(c) }))],
    value: current ? current.id : '', label: t('send.filter.title', { table }), onChange: show,
  });
  input.addEventListener('input', () => onChange(filter()));
  show(current ? current.id : '');
  return el('div', { class: 'filter-field' }, el('p', { class: 'field-title' }, t('send.filter.title', { table })), pick, input, hint);
}
