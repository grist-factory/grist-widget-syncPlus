// Listes de choix et formats d'une colonne (widgetOptions de Grist) : la SOURCE les envoie avec la
// description des colonnes (`opts`), la CIBLE les reprend dans les colonnes qu'elle a créées. Rien
// n'est changé dans une colonne que la CIBLE a choisie : seules ses colonnes à elle sont complétées,
// et seulement de ce qui leur manque (un choix ajouté à la SOURCE s'ajoute à la liste ; un format
// retouché ici reste). Dans les deux sens, seules des clés connues aux valeurs contrôlées passent.
// Avec `extras` (l'export envoie « la mise en forme des colonnes ») passent aussi le style de l'en-tête et les
// règles de mise en forme conditionnelle, réécrites d'après une grammaire stricte (voir rules.js).
import { normalizeRule } from './rules.js';
const COLOR = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;
const FORMAT = /^[A-Za-z0-9 .,:;/_'()[\]-]{1,40}$/; // format de date ou d'heure (moment.js)
const bool = v => typeof v === 'boolean';
const oneOf = list => v => list.includes(v);
const int = max => v => Number.isInteger(v) && v >= 0 && v <= max;
const STYLE = {
  fillColor: v => COLOR.test(v), textColor: v => COLOR.test(v),
  fontBold: bool, fontItalic: bool, fontUnderline: bool, fontStrikethrough: bool,
};
const HEADER = {
  headerTextColor: v => COLOR.test(v), headerFillColor: v => COLOR.test(v),
  headerFontBold: bool, headerFontItalic: bool, headerFontUnderline: bool, headerFontStrikethrough: bool,
};
const RULES_MAX = 10;
const COMMON = { alignment: oneOf(['left', 'center', 'right']), wrap: bool, ...STYLE };
const NUMBER = {
  numMode: oneOf(['currency', 'decimal', 'percent', 'scientific']), currency: v => /^[A-Z]{3}$/.test(v), numSign: oneOf(['parens']),
  decimals: int(10), maxDecimals: int(10), widget: oneOf(['TextBox', 'Spinner']),
};
const DATE = { dateFormat: v => FORMAT.test(v), isCustomDateFormat: bool };
const KEYS = {
  Text: { widget: oneOf(['TextBox']) }, // ni HyperLink ni Markdown : le texte reçu ne devient pas un lien cliquable ni du texte mis en forme
  Bool: { widget: oneOf(['CheckBox', 'Switch', 'TextBox']) },
  Numeric: NUMBER,
  Int: NUMBER,
  Date: DATE,
  DateTime: { ...DATE, timeFormat: v => FORMAT.test(v), isCustomTimeFormat: bool },
  Choice: {},
  ChoiceList: {},
};
const CHOICES_MAX = 500;
const CHOICE_LEN = 200;
const OPTS_MAX = 20000; // caractères de JSON par colonne : au-delà, les couleurs des choix, puis rien

const parse = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    return {};
  }
};
export const isChoice = type => type === 'Choice' || type === 'ChoiceList';

function choicesOf(raw) {
  const choices = Array.isArray(raw.choices) ? [...new Set(raw.choices.filter(c => typeof c === 'string' && c && c.length <= CHOICE_LEN))].slice(0, CHOICES_MAX) : [];
  const given = raw.choiceOptions && typeof raw.choiceOptions === 'object' ? raw.choiceOptions : {};
  const choiceOptions = Object.fromEntries(choices.filter(c => Object.hasOwn(given, c)).map(c => [c, pick(given[c], STYLE)])
    .filter(([, style]) => Object.keys(style).length));
  return { ...(choices.length ? { choices } : {}), ...(Object.keys(choiceOptions).length ? { choiceOptions } : {}) };
}

// Règles de mise en forme conditionnelle, telles qu'elles sont envoyées : [{ when, <style> }], la condition
// réécrite (rules.js), le style limité aux clés connues. Une règle sans condition lisible ou sans style est laissée.
function rulesOf(list) {
  const rules = (Array.isArray(list) ? list.slice(0, RULES_MAX) : []).map((rule) => {
    const when = normalizeRule(rule && rule.when);
    const style = pick(rule, STYLE);
    return when && Object.keys(style).length ? { when, ...style } : null;
  }).filter(Boolean);
  return rules.length ? { rules } : {};
}

function pick(raw, keys) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return Object.fromEntries(Object.entries(keys).filter(([k, ok]) => Object.hasOwn(source, k) && ok(source[k])).map(([k]) => [k, source[k]]));
}

// Options d'une colonne de type `type` (celui qu'elle a dans l'autre document : une Référence part
// en texte), contrôlées ; null s'il n'y en a pas. `extras` : style d'en-tête et règles conditionnelles
// (`rules`, déjà au format envoyé) passent aussi.
export function columnOptions(type, widgetOptions, { extras = false } = {}) {
  const base = String(type || '').split(':')[0];
  if (!KEYS[base]) return null;
  const raw = parse(widgetOptions);
  let opts = { ...pick(raw, { ...COMMON, ...KEYS[base], ...(extras ? HEADER : {}) }), ...(isChoice(base) ? choicesOf(raw) : {}), ...(extras ? rulesOf(raw.rules) : {}) };
  if (JSON.stringify(opts).length > OPTS_MAX) delete opts.choiceOptions;
  if (JSON.stringify(opts).length > OPTS_MAX) delete opts.rules;
  if (JSON.stringify(opts).length > OPTS_MAX) opts = {};
  return Object.keys(opts).length ? opts : null;
}

// Options d'une colonne d'ici (`current`, widgetOptions) complétées par celles reçues (`sent`) :
// clés absentes ajoutées, choix nouveaux ajoutés en fin de liste avec leurs couleurs. Rend le texte
// à écrire, ou null si rien ne manque.
export function fillOptions(type, current, sent) {
  const here = parse(current);
  const wanted = columnOptions(type, sent, { extras: true });
  if (!wanted) return null;
  const next = { ...here };
  for (const [k, v] of Object.entries(wanted)) if (!['choices', 'choiceOptions', 'rules'].includes(k) && !Object.hasOwn(here, k)) next[k] = v;
  if (wanted.choices) {
    const had = Array.isArray(here.choices) ? here.choices : [];
    const added = wanted.choices.filter(c => !had.includes(c)).slice(0, Math.max(0, CHOICES_MAX - had.length)); // la liste d'ici reste bornée
    if (added.length) next.choices = [...had, ...added];
    const styles = Object.entries(wanted.choiceOptions || {}).filter(([c]) => added.includes(c));
    if (styles.length) next.choiceOptions = { ...(here.choiceOptions || {}), ...Object.fromEntries(styles) };
  }
  return JSON.stringify(next) === JSON.stringify(here) ? null : JSON.stringify(next);
}

// Choix d'une colonne de choix d'ici complétés des valeurs reçues (`values` : texte d'une cellule Choix,
// ou liste ['L', …] d'une Liste de choix). Sert quand la SOURCE n'envoie pas de liste (export filtré,
// colonne sans liste) : la CIBLE n'apprend que les valeurs qu'elle reçoit. Les nouveaux choix
// s'ajoutent en fin de liste, bornés comme une liste envoyée. Rend le texte à écrire, ou null.
export function receivedChoices(current, values) {
  const here = parse(current);
  const had = Array.isArray(here.choices) ? here.choices : [];
  const known = new Set(had);
  const added = [];
  for (const cell of values) {
    for (const choice of Array.isArray(cell) ? cell.slice(1) : [cell]) {
      if (typeof choice === 'string' && choice && choice.length <= CHOICE_LEN && !known.has(choice) && had.length + added.length < CHOICES_MAX) {
        known.add(choice);
        added.push(choice);
      }
    }
  }
  return added.length ? JSON.stringify({ ...here, choices: [...had, ...added] }) : null;
}

// Colonne d'ici qu'on peut compléter : créée par le widget (`own`, colonnes envoyées notées à la
// création), ou, pour une réception d'avant la 0.12 (`own` absent), une colonne de choix sans
// aucun choix (le widget les créait ainsi).
export const ownsColumn = (own, sentId, column) => (own ? own.includes(sentId)
  : isChoice(column.type) && !(parse(column.widgetOptions).choices || []).length);

// Reprise voulue de la mise en forme (bouton « Reprendre la mise en forme de la SOURCE ») : chaque clé de
// style que la SOURCE peut envoyer pour ce type prend la valeur de la SOURCE, ou disparaît si la SOURCE n'en
// a pas ; le reste (liste de choix d'ici, règles) est laissé, et les choix nouveaux s'ajoutent comme
// ailleurs. Rend le texte à écrire, ou null s'il n'y a rien à changer.
export function replaceOptions(type, current, sent) {
  const here = parse(current);
  const base = String(type || '').split(':')[0];
  if (!KEYS[base]) return null;
  const wanted = columnOptions(type, sent, { extras: true }) || {};
  const next = { ...here };
  for (const key of Object.keys({ ...COMMON, ...KEYS[base], ...HEADER })) {
    if (Object.hasOwn(wanted, key)) next[key] = wanted[key];
    else delete next[key];
  }
  const text = JSON.stringify(next);
  const filled = fillOptions(type, text, sent) || text;
  return filled === JSON.stringify(here) ? null : filled;
}

// Règles de mise en forme conditionnelle envoyées pour une colonne (`opts.rules`), contrôlées.
export const sentRules = opts => (opts && Array.isArray(opts.rules) ? rulesOf(opts.rules).rules || [] : []);

// Styles des règles déjà posées sur une colonne d'ici (`rulesOptions` de ses options), dans l'ordre de ses règles.
export const ruleStyles = widgetOptions => (Array.isArray(parse(widgetOptions).rulesOptions) ? parse(widgetOptions).rulesOptions : []);

// Options d'une colonne d'ici avec les styles de ses règles remplacés (liste vide : plus de règle), les autres
// clés laissées telles quelles.
export function withRuleStyles(widgetOptions, styles) {
  const next = { ...parse(widgetOptions) };
  if (styles.length) next.rulesOptions = styles;
  else delete next.rulesOptions;
  return JSON.stringify(next);
}

// Style d'une règle envoyée, tel que Grist le range dans `rulesOptions`.
export const ruleStyle = rule => pick(rule, STYLE);
