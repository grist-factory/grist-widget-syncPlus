// SOURCE : filtre des lignes d'une table, à l'étape Contenu de l'assistant d'export (comparaisons :
// filters.js). Chaque condition : une colonne, un opérateur selon son type, et ses valeurs, cochées
// parmi celles de la colonne (avec leur nombre de lignes) ou tapées. Les lignes de la table sont lues
// à la première ouverture (`load`), pour proposer les valeurs et dire combien de lignes partiront.
import { OPERATORS, columnValues, filterKind, filterTester, operandOf, rowFilter } from '../engine/logic/filters.js';
import { fetchRows } from '../grist.js';
import { checkList, el, icon, message, pickField, withHelp } from '../ui.js';
import { LANG, t } from '../i18n.js';

// Libellé d'un opérateur : propre au type s'il en a un (« contient l'une de » pour une liste, « avant
// le » pour une date), sinon commun.
function opLabel(kind, op) {
  const own = `send.op.${kind}.${op}`;
  return t(own) === own ? t(`send.op.${op}`) : t(own);
}

const dayText = day => new Date(`${day}T00:00:00`).toLocaleDateString(LANG);
function valueText(kind, value) {
  if (kind === 'date') return dayText(value);
  return kind === 'number' ? Number(value).toLocaleString(LANG) : t('send.filter.quoted', { value });
}
function pickedText(cond) {
  const shown = (cond.labels || cond.values).map(String);
  const first = shown.slice(0, 3).map(value => t('send.filter.quoted', { value })).join(', ');
  return shown.length > 3 ? t('send.filter.more', { values: first, n: shown.length - 3 }) : first;
}

// Résumé d'un filtre en une ligne : « Ville est l'une de « Pau », « Lyon » et Montant > 100 ».
export function filterSummary(filter) {
  const spec = rowFilter(filter);
  if (!spec) return '';
  return spec.conds.map((cond) => {
    const kind = filterKind(cond.source);
    const need = operandOf(cond.op);
    const values = need === 'pick' ? pickedText(cond)
      : need === 'two' ? t('send.filter.range', { from: valueText(kind, cond.values[0]), to: valueText(kind, cond.values[1]) })
        : need === 'one' ? valueText(kind, cond.values[0]) : '';
    return [cond.id, opLabel(kind, cond.op), values].filter(Boolean).join(' ');
  }).join(t(spec.mode === 'any' ? 'send.filter.or' : 'send.filter.and'));
}

// Condition neuve sur une colonne : son premier opérateur, sans valeur.
const freshCond = col => ({ id: col.id, source: col.source, visible: col.visible, op: OPERATORS[filterKind(col.source)][0], values: [] });

// Ce que l'éditeur lit dans la table : ses lignes (`rows`), et le texte affiché des fiches citées par
// une colonne Référence (`labels`, lu une fois par table visée).
function filterData(table) {
  const tableData = { rows: null, labels: {}, loading: null, failed: false };
  const cache = new Map();
  tableData.labelsFor = async (cond) => {
    const kind = filterKind(cond.source);
    if (kind !== 'ref' && kind !== 'refs') return;
    const target = cond.source.split(':')[1];
    const key = `${target}.${cond.visible}`;
    if (!cache.has(key)) cache.set(key, fetchRows(target).then(rows => new Map(rows.map(r => [r.id, cond.visible ? r[cond.visible] : r.id]))));
    tableData.labels[cond.id] = await cache.get(key);
  };
  // Lignes de la table et textes des Références des conditions `conds`.
  tableData.read = async (conds) => {
    try {
      tableData.rows = await fetchRows(table);
      await Promise.all(conds.map(tableData.labelsFor));
    } catch (e) {
      tableData.rows = null;
      tableData.failed = true;
    }
  };
  return tableData;
}

// Valeurs cochées d'une condition « est l'une de » : celles de la colonne, avec leur nombre de lignes
// (`tableData.rows`, lues à l'ouverture). Une valeur cochée qui n'est plus dans la colonne reste
// proposée, cochée.
function pickEditor(cond, tableData, name, changed) {
  if (!tableData.rows) return el('p', { class: 'muted small' }, t(tableData.failed ? 'send.filter.unreadable' : 'send.filter.reading'));
  const found = columnValues(cond, tableData.rows, tableData.labels[cond.id]);
  const labels = new Map(found.map(v => [v.value, v.label]));
  (cond.values || []).forEach((v, i) => { if (!labels.has(v)) { labels.set(v, String((cond.labels || [])[i] ?? v)); found.push({ value: v, label: labels.get(v), n: 0 }); } });
  return checkList({
    items: found.map(v => ({ value: v.value, label: v.label, hint: t('send.filter.rows', { n: v.n }) })),
    checked: cond.values, label: name, wide: true,
    onChange: (values) => { cond.values = values; cond.labels = values.map(v => labels.get(v)); changed(); },
  });
}

// Une zone de saisie (une valeur) ou deux (« de … à … »), du type de la colonne ; pour un texte, les
// valeurs de la colonne sont proposées.
function typedEditor(cond, kind, tableData, { table, index, name }, changed) {
  const need = operandOf(cond.op);
  const type = kind === 'number' ? 'number' : kind === 'date' ? 'date' : 'text';
  const listId = `gristsync-filter-values-${table}-${index}`;
  const input = i => el('input', {
    class: 'input', type, step: type === 'number' ? 'any' : null, value: cond.values[i] ?? '', list: type === 'text' && tableData.rows ? listId : null,
    'aria-label': need === 'two' ? t(i ? 'send.filter.to' : 'send.filter.from', { n: index + 1 }) : name,
    oninput: (e) => { cond.values[i] = e.target.value; changed(); },
  });
  const suggestions = type === 'text' && tableData.rows
    ? el('datalist', { id: listId }, columnValues(cond, tableData.rows, tableData.labels[cond.id]).slice(0, 200).map(v => el('option', { value: v.label }))) : null;
  return el('div', { class: 'filter-values' }, input(0), need === 'two' ? [el('span', { class: 'muted' }, t('send.filter.betweenAnd')), input(1)] : null, suggestions);
}

// Ce que le filtre dit sous les conditions : combien de lignes partiront, combien de conditions
// sont ignorées (incomplètes), et une alerte si rien ne part.
function countView(tableData, state) {
  const total = tableData.rows.length;
  const spec = rowFilter({ mode: state.mode, conds: state.conds });
  const n = spec ? tableData.rows.filter(filterTester(spec, tableData.labels)).length : total;
  const ignored = state.conds.length - (spec ? spec.conds.length : 0);
  return [
    el('p', {}, spec ? t('send.filter.count', { n, total }) : t('send.filter.countAll', { total })),
    ignored ? el('p', { class: 'muted' }, t('send.filter.incomplete', { n: ignored })) : null,
    spec && !n && total ? message('warn', t('send.filter.nothing')) : null].filter(Boolean);
}

// Colonne d'une condition : `onPick` reçoit la condition neuve sur la colonne choisie.
const columnPicker = (usable, labelOf, cond, index, onPick) => pickField({
  items: usable.map(c => ({ value: c.id, label: labelOf(c) })), value: cond.id, label: t('send.filter.column', { n: index + 1 }),
  onChange: id => onPick(freshCond(usable.find(c => c.id === id))),
});

// Opérateur d'une condition, parmi ceux de son type (celui d'un ancien filtre reste proposé).
const operatorPicker = (kind, cond, index, onPick) => pickField({
  items: (OPERATORS[kind].includes(cond.op) ? OPERATORS[kind] : [...OPERATORS[kind], cond.op]).map(op => ({ value: op, label: opLabel(kind, op) })),
  value: cond.op, label: t('send.filter.operator', { n: index + 1 }), onChange: onPick,
});

const removeButton = (index, onclick) => el('button', {
  class: 'icon-button', type: 'button', title: t('send.filter.remove', { n: index + 1 }), 'aria-label': t('send.filter.remove', { n: index + 1 }), onclick,
}, icon('trash'));

// Toutes les conditions, ou l'une d'elles.
const modeRadios = (table, state, changed) => [el('span', {}, t('send.filter.mode')), ...['all', 'any'].map(value => el('label', { class: 'check' },
  el('input', { type: 'radio', name: `gristsync-filter-mode-${table}`, value, checked: state.mode === value, onchange: () => { state.mode = value; changed(); } }),
  t(`send.filter.mode.${value}`)))];

// `columns` : colonnes de la table qu'un filtre peut lire ; `current` : filtre de l'export, ou null.
// `onChange` reçoit le filtre ({ mode, conds }), ou null sans condition. `labelOf` : nom d'une
// colonne. Rend { node, load }.
export function filterEditor({ table, columns, current, labelOf, onChange }) {
  const usable = columns.filter(c => filterKind(c.source));
  const start = rowFilter(current);
  const state = { mode: start ? start.mode : 'all', conds: start ? start.conds.map(c => ({ ...c })) : [] };
  const tableData = filterData(table);
  const conds = el('div', { class: 'filter-conds' });
  const mode = el('div', { class: 'filter-mode', role: 'radiogroup', 'aria-label': t('send.filter.mode') });
  const count = el('div', { class: 'small', 'aria-live': 'polite' });
  const add = el('button', { class: 'btn btn-small', type: 'button', onclick: () => addCond() }, icon('plus'), t('send.filter.add'));

  const changed = () => {
    onChange(state.conds.length ? { mode: state.mode, conds: state.conds.map(c => ({ ...c })) } : null);
    showCount();
  };

  // Lignes de la table et textes des Références des conditions, puis tout est redessiné.
  function load() {
    tableData.loading ||= (async () => {
      count.replaceChildren(el('p', { class: 'muted' }, t('send.filter.reading')));
      await tableData.read(state.conds);
      render();
      if (tableData.failed) count.replaceChildren(message('warn', t('send.filter.unreadable')));
    })();
    return tableData.loading;
  }

  function showCount() {
    if (tableData.rows) count.replaceChildren(...countView(tableData, state));
  }

  async function addCond() {
    if (!usable.length) return;
    const cond = freshCond(usable[0]);
    state.conds.push(cond);
    if (tableData.rows) await tableData.labelsFor(cond).catch(() => null);
    render();
    changed();
    load();
  }

  // Valeurs d'une condition, selon ce qu'attend son opérateur.
  function valueEditor(cond, kind, index) {
    const need = operandOf(cond.op);
    const name = t('send.filter.value', { n: index + 1 });
    if (need === 'none') return null;
    return need === 'pick' ? pickEditor(cond, tableData, name, changed) : typedEditor(cond, kind, tableData, { table, index, name }, changed);
  }

  function condBlock(cond, index) {
    const kind = filterKind(cond.source);
    const column = columnPicker(usable, labelOf, cond, index, async (fresh) => {
      state.conds[index] = fresh;
      await tableData.labelsFor(fresh).catch(() => null);
      render();
      changed();
    });
    const operator = operatorPicker(kind, cond, index, (op) => {
      if (operandOf(op) !== operandOf(cond.op)) Object.assign(cond, { values: [], labels: undefined });
      cond.op = op;
      render();
      changed();
    });
    const remove = removeButton(index, () => { state.conds.splice(index, 1); render(); changed(); });
    return el('div', { class: 'filter-cond', role: 'group', 'aria-label': t('send.filter.condition', { n: index + 1 }) },
      el('div', { class: 'filter-cond-head' }, column, operator, remove), valueEditor(cond, kind, index));
  }

  function render() {
    conds.replaceChildren(...(state.conds.length ? state.conds.map(condBlock) : [el('p', { class: 'muted small' }, t('send.filter.none'))]));
    mode.replaceChildren(...(state.conds.length > 1 ? modeRadios(table, state, changed) : []));
    add.hidden = !usable.length;
    showCount();
  }

  render();
  const node = el('div', { class: 'filter-field' }, withHelp(el('p', { class: 'field-title' }, t('send.filter.title', { table })), t('send.filter.help')),
    conds, add, mode, count);
  return { node, load };
}
