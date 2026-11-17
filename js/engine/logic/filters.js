// SOURCE : filtre des lignes d'une table d'un export. Des conditions sur ses colonnes (colonne,
// opérateur, valeurs), à remplir toutes (`mode` 'all') ou au moins une ('any'). Écrit dans la ligne
// 'filtre' de Synchro et lu par la formule (`keep`, voir formulas.js) ; l'assistant en montre
// l'effet avec la même logique (filterTester), sur les lignes lues dans le document.
//
// Valeurs comparées, selon le type de la colonne (`filterKind`) :
//  - texte (Texte, Choix, etc.) : le texte affiché, sans majuscules ni espaces autour ;
//  - liste (Liste de choix) : chacun de ses choix, de même ;
//  - ref, refs (Référence, Liste de références) : le numéro de la fiche citée, pour « est l'une
//    de » (une fiche renommée reste dans le filtre ; renommer « Bordeaux » ne doit pas effacer ses
//    lignes chez les destinataires), et le texte affiché pour « contient » ;
//  - number : le nombre ; date : le jour « AAAA-MM-JJ », dans le fuseau de la colonne ;
//  - bool : cochée ou non.
// Une cellule vide n'a aucune valeur : elle ne remplit que « est vide » et les négations.
import { COL_ID } from './common.js';

export function filterKind(source) {
  const s = String(source || '');
  if (s === 'Attachments') return null;
  if (s === 'Bool') return 'bool';
  if (s === 'Numeric' || s === 'Int') return 'number';
  if (s === 'Date' || s.startsWith('DateTime')) return 'date';
  if (s.startsWith('RefList:')) return 'refs';
  if (s.startsWith('Ref:')) return 'ref';
  if (s === 'ChoiceList') return 'list';
  return 'text';
}

// Opérateurs proposés par type, dans l'ordre du choix. 'eq' compare le texte affiché pour les
// types texte (et un filtre d'avant la 0.11, qui ne connaissait que lui) ; le nombre ou le jour
// sinon. Un opérateur « not… » est la négation de celui qu'il nomme.
export const OPERATORS = {
  text: ['in', 'notin', 'eq', 'contains', 'notcontains', 'starts', 'empty', 'notempty'],
  list: ['in', 'notin', 'empty', 'notempty'],
  ref: ['in', 'notin', 'contains', 'notcontains', 'empty', 'notempty'],
  refs: ['in', 'notin', 'contains', 'notcontains', 'empty', 'notempty'],
  number: ['eq', 'noteq', 'gt', 'ge', 'lt', 'le', 'between', 'empty', 'notempty'],
  date: ['eq', 'lt', 'le', 'gt', 'ge', 'between', 'empty', 'notempty'],
  bool: ['true', 'false'],
};
const ALL_OPS = new Set(Object.values(OPERATORS).flat());

// Ce que l'opérateur attend : des valeurs cochées ('pick'), une valeur ('one'), deux ('two'), rien.
export function operandOf(op) {
  const base = op.startsWith('not') ? op.slice(3) : op;
  if (base === 'in') return 'pick';
  if (base === 'between') return 'two';
  return ['empty', 'true', 'false'].includes(base) ? 'none' : 'one';
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const lower = x => String(x ?? '').trim().toLowerCase();

// Formes des valeurs d'une condition (undefined : la valeur ne vaut rien pour ce type).
const asRef = v => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
const asNumber = v => (v === '' || v === null || !Number.isFinite(Number(v)) ? undefined : Number(v));
const asDay = v => (DAY.test(String(v ?? '')) ? String(v) : undefined);
const asText = v => lower(v) || undefined;
function shapeOf(kind, op) {
  const base = op.startsWith('not') ? op.slice(3) : op;
  if (base === 'in' && (kind === 'ref' || kind === 'refs')) return asRef;
  if (['contains', 'starts', 'in'].includes(base) || !['number', 'date'].includes(kind)) return asText;
  return kind === 'number' ? asNumber : asDay;
}

// Condition remise en forme, ou null si elle est incomplète (une condition sans valeur ne doit rien
// filtrer : « est l'une de » sans rien de coché enverrait zéro ligne, et effacerait tout chez les
// destinataires). `labels` : texte des valeurs cochées, pour les résumés (la formule l'ignore).
function normalCond(cond) {
  if (!cond || !COL_ID.test(String(cond.id || ''))) return null;
  const source = String(cond.source || '');
  const kind = filterKind(source);
  const op = String(cond.op || '');
  if (!kind || !ALL_OPS.has(op)) return null;
  const out = { id: cond.id, source, visible: String(cond.visible || ''), op, values: [] };
  const need = operandOf(op);
  const raw = Array.isArray(cond.values) ? cond.values : [];
  if (need === 'pick') return pickedCond(out, raw, Array.isArray(cond.labels) ? cond.labels : [], shapeOf(kind, op));
  return need === 'none' ? out : typedCond(out, raw.slice(0, need === 'two' ? 2 : 1), need === 'two' ? 2 : 1, shapeOf(kind, op));
}
function typedCond(out, raw, size, shape) {
  const values = raw.map(shape);
  return values.length === size && !values.includes(undefined) ? { ...out, values } : null;
}
// Valeurs cochées : sans doublon ni valeur qui ne vaut rien pour ce type, chacune avec son texte.
function pickedCond(out, raw, labels, shape) {
  const picked = new Map();
  raw.forEach((v, i) => {
    const value = shape(v);
    if (value !== undefined && !picked.has(value)) picked.set(value, String(labels[i] ?? v));
  });
  return picked.size ? { ...out, values: [...picked.keys()], labels: [...picked.values()] } : null;
}

// Filtre d'avant la 0.11 : une colonne et le texte qu'elle affiche ({ id, source, visible, value }).
function legacyConds(filter) {
  if (!filter.id) return [];
  const value = lower(filter.value);
  if (filter.source === 'Bool') return [{ ...filter, op: ['oui', 'yes', 'vrai', 'true', '1', 'x'].includes(value) ? 'true' : 'false' }];
  return [{ ...filter, op: value ? 'eq' : 'empty', values: value ? [value] : [] }];
}

// Filtre tel que la formule le lit ({ mode, conds }), ou null s'il ne garde aucune condition
// complète (toutes les lignes partent).
export function rowFilter(filter) {
  if (!filter || typeof filter !== 'object') return null;
  const conds = (Array.isArray(filter.conds) ? filter.conds : legacyConds(filter)).map(normalCond).filter(Boolean);
  return conds.length ? { mode: filter.mode === 'any' ? 'any' : 'all', conds } : null;
}

// Colonnes que lit un filtre (MajLe les suit : une ligne qui entre dans le filtre doit partir).
export const filterColumns = filter => [...new Set(((rowFilter(filter) || {}).conds || []).map(c => c.id))];

// ---------------------------------------------------------------------------------------------
// Les mêmes comparaisons qu'en Python, sur les lignes lues par le widget (valeurs brutes de Grist :
// Référence en numéro, listes en ['L', …], dates en secondes). `labels` : pour une colonne
// Référence, numéro de fiche -> valeur de sa colonne affichée.

// Texte d'une valeur, comme `txt` dans la formule.
export function cellText(x) {
  if (x === null || x === undefined) return '';
  if (typeof x === 'boolean') return x ? 'oui' : 'non';
  if (Array.isArray(x)) return x.map(cellText).join(', ');
  return lower(x);
}

const listOf = x => (Array.isArray(x) ? (x[0] === 'L' ? x.slice(1) : x) : []);

// Jour « AAAA-MM-JJ » d'une date (secondes) ; pour une Date et heure, dans le fuseau de la colonne.
function dayOf(source, x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  const zone = source.startsWith('DateTime:') ? source.slice(9) : 'UTC';
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(x * 1000));
  } catch (e) {
    return new Date(x * 1000).toISOString().slice(0, 10);
  }
}

// Texte affiché d'une cellule (`g` puis `txt` dans la formule).
function shownText(kind, x, labels) {
  const label = id => (labels ? labels.get(id) : id);
  if (kind === 'ref') return x ? cellText(label(x)) : '';
  if (kind === 'refs') return lower(listOf(x).map(id => String(label(id) ?? '')).join(', '));
  return cellText(kind === 'list' ? listOf(x) : x);
}

// Valeurs d'une cellule (`items` dans la formule).
function cellItems(kind, source, x, labels) {
  if (kind === 'ref') return Number.isInteger(x) && x > 0 ? [x] : [];
  if (kind === 'refs') return listOf(x).filter(id => Number.isInteger(id) && id > 0);
  if (kind === 'list') return listOf(x).map(cellText);
  if (kind === 'bool') return [x === true];
  if (kind === 'number') return typeof x === 'number' && Number.isFinite(x) ? [x] : [];
  if (kind === 'date') return dayOf(source, x) ? [dayOf(source, x)] : [];
  const text = shownText(kind, x, labels);
  return text ? [text] : [];
}

const COMPARE = {
  eq: (x, y) => x === y, lt: (x, y) => x < y, le: (x, y) => x <= y, gt: (x, y) => x > y, ge: (x, y) => x >= y,
};

function passes(cond, row, labels) {
  const { op, values: w } = cond;
  if (op.startsWith('not')) return !passes({ ...cond, op: op.slice(3) }, row, labels);
  const kind = filterKind(cond.source);
  const x = row[cond.id];
  if (['contains', 'starts', 'eq'].includes(op) && !['number', 'date'].includes(kind)) {
    const text = shownText(kind, x, labels);
    if (op === 'eq') return text === w[0];
    return op === 'starts' ? text.startsWith(w[0]) : text.includes(w[0]);
  }
  const items = cellItems(kind, cond.source, x, labels);
  if (op === 'empty') return !items.length;
  if (op === 'in') return items.some(i => w.includes(i));
  if (op === 'true') return items[0] === true;
  if (op === 'false') return items[0] !== true;
  if (!items.length) return false;
  if (op === 'between') return w[0] <= items[0] && items[0] <= w[1];
  return COMPARE[op] ? COMPARE[op](items[0], w[0]) : false;
}

// Fonction qui dit si une ligne part. `labels` : { colonne : Map(numéro de fiche -> texte affiché) }.
export function filterTester(filter, labels = {}) {
  const spec = rowFilter(filter);
  if (!spec) return () => true;
  const tests = spec.conds.map(c => row => passes(c, row, labels[c.id]));
  return row => (spec.mode === 'any' ? tests.some(f => f(row)) : tests.every(f => f(row)));
}

// Valeurs présentes dans une colonne, à cocher : [{ value, label, n }] (n : nombre de lignes),
// triées par libellé. Le texte garde ses majuscules pour l'affichage ; sa valeur est en minuscules.
export function columnValues(cond, rows, labels) {
  const kind = filterKind(cond.source);
  const found = new Map();
  const add = (value, label) => {
    const seen = found.get(value);
    if (seen) seen.n += 1; else found.set(value, { value, label, n: 1 });
  };
  for (const row of rows) {
    const x = row[cond.id];
    if (kind === 'ref' || kind === 'refs') {
      for (const id of new Set(cellItems(kind, cond.source, x))) add(id, String((labels && labels.get(id)) ?? `#${id}`));
    } else if (kind === 'list') {
      for (const item of new Set(listOf(x).map(y => String(y ?? '').trim()).filter(Boolean))) add(item.toLowerCase(), item);
    } else if (kind === 'text') {
      const label = Array.isArray(x) ? listOf(x).join(', ') : String(x ?? '').trim();
      if (label) add(cellText(x), label);
    }
  }
  return [...found.values()].sort((a, b) => a.label.localeCompare(b.label, 'fr', { numeric: true, sensitivity: 'base' }));
}
