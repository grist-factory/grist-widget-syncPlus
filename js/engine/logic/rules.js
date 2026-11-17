// Mise en forme conditionnelle d'une colonne. Une règle de Grist est une formule Python (une colonne
// cachée `gristHelper_ConditionalRule`) : la copier telle quelle ferait exécuter dans la CIBLE un texte
// écrit ailleurs, avec accès à toutes ses tables. La règle ne passe donc jamais par son texte d'origine :
// elle est lue dans une grammaire stricte (`parseRule`), et c'est la formule réécrite d'après l'arbre
// lu (`printRule`) que la CIBLE pose. Ce qui sort de la grammaire (appel de fonction, attribut,
// chaîne spéciale, comparaison enchaînée…) ne part pas : la SOURCE le dit.
//
// Grammaire (priorités de Python) :
//   ou      := et ('or' et)*          et   := non ('and' non)*        non := 'not' non | comparaison
//   comparaison := somme ( ('=='|'!='|'<'|'<='|'>'|'>=') somme | ['not'] 'in' liste | 'is' ['not'] 'None' )?
//   somme   := produit (('+'|'-') produit)*      produit := unaire (('*'|'/') unaire)*     unaire := '-' unaire | atome
//   atome   := nombre | chaîne | True | False | None | colonne | TODAY() | '(' ou ')'
//   colonne := '$' nom | 'rec.' nom           liste := '(' valeur, … ')' | '[' valeur, … ']'
// Une comparaison ne s'enchaîne pas (`a < b < c` n'est pas lue) ; un nom de colonne est un identifiant
// simple ; une chaîne n'a ni guillemet, ni barre oblique inverse, ni caractère de contrôle.
import { COL_ID } from './common.js';

export const RULE_MAX = 300; // caractères d'une règle
const STRING_MAX = 100;
const LIST_MAX = 50;
const NODES_MAX = 60;
const DEPTH_MAX = 12;
const NUMBER = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const WORD = /^[A-Za-z_][A-Za-z0-9_]*/;
const OPERATORS = ['==', '!=', '<=', '>=', '<', '>', '+', '-', '*', '/', '(', ')', '[', ']', ','];
const COMPARE = new Set(['==', '!=', '<', '<=', '>', '>=']);
const WORDS = new Set(['and', 'or', 'not', 'in', 'is', 'True', 'False', 'None', 'TODAY']);

class Refused extends Error {}
const refuse = () => { throw new Refused('règle hors grammaire'); };

// Un jeton, lu à partir de `i` : `[jeton, indice suivant]`. Tout ce qui n'est pas reconnu est refusé.
function lexColumn(text, i) {
  const name = WORD.exec(text.slice(i + 1));
  if (!name || !COL_ID.test(name[0])) refuse();
  return [{ type: 'col', value: name[0] }, i + 1 + name[0].length];
}
function lexNumber(text, i) {
  const rest = text.slice(i);
  const num = NUMBER.exec(rest);
  if (!num || /^[A-Za-z_]/.test(rest.slice(num[0].length))) refuse();
  return [{ type: 'num', value: num[0] }, i + num[0].length];
}
function lexString(text, i) {
  const end = text.indexOf(text[i], i + 1);
  const value = end < 0 ? '' : text.slice(i + 1, end);
  if (end < 0 || value.length > STRING_MAX || /[\\"'\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200b-\u200f\u202a-\u202e\u2066-\u206f\ufeff]/.test(value)) refuse();
  return [{ type: 'str', value }, end + 1];
}
function lexWord(text, i) {
  const rest = text.slice(i);
  const word = WORD.exec(rest)[0];
  if (word === 'rec' && rest[3] === '.') {
    const name = WORD.exec(rest.slice(4));
    if (!name) refuse();
    return [{ type: 'col', value: name[0] }, i + 4 + name[0].length];
  }
  if (!WORDS.has(word)) refuse();
  return [{ type: 'word', value: word }, i + word.length];
}
function lexOperator(text, i) {
  const rest = text.slice(i);
  const op = OPERATORS.find(o => rest.startsWith(o));
  if (!op) refuse();
  return [{ type: 'op', value: op }, i + op.length];
}
function nextToken(text, i) {
  const ch = text[i];
  if (ch === '$') return lexColumn(text, i);
  if (/[0-9]/.test(ch)) return lexNumber(text, i);
  if (ch === '"' || ch === "'") return lexString(text, i);
  if (/[A-Za-z_]/.test(ch)) return lexWord(text, i);
  return lexOperator(text, i);
}

function tokens(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    if (' \t\r\n'.includes(text[i])) { i++; continue; }
    const [token, next] = nextToken(text, i);
    out.push(token);
    i = next;
  }
  return out;
}

const CONSTANTS = ['True', 'False', 'None'];

// Lecture des jetons en arbre, du plus lâche (`or`) au plus serré (une valeur) ; `nodes` et `depth` bornent sa taille.
class Parser {
  constructor(list) {
    this.list = list;
    this.at = 0;
    this.nodes = 0;
  }
  peek() { return this.list[this.at]; }
  step() { return this.list[this.at++]; }
  is(type, value) {
    const tok = this.list[this.at];
    return tok && tok.type === type && (value === undefined || tok.value === value);
  }
  take(type, value) {
    if (!this.is(type, value)) refuse();
    return this.step();
  }
  make(node) {
    if (++this.nodes > NODES_MAX) refuse();
    return node;
  }
  literal() {
    const minus = this.is('op', '-') && this.step();
    const tok = this.peek();
    if (!tok || (minus && tok.type !== 'num')) refuse();
    if (tok.type === 'num') return this.make({ k: 'num', v: `${minus ? '-' : ''}${this.step().value}` });
    if (tok.type === 'str') return this.make({ k: 'str', v: this.step().value });
    if (tok.type === 'word' && CONSTANTS.includes(tok.value)) return this.make({ k: 'const', v: this.step().value });
    return refuse();
  }
  items() {
    const close = this.take('op', this.is('op', '(') ? '(' : '[').value === '(' ? ')' : ']';
    const found = [];
    while (!this.is('op', close)) {
      found.push(this.literal());
      if (found.length > LIST_MAX) refuse();
      if (this.is('op', ',')) this.at++;
      else if (!this.is('op', close)) refuse();
    }
    this.take('op', close);
    return found;
  }
  atom(depth) {
    if (depth > DEPTH_MAX) refuse();
    const tok = this.peek();
    if (!tok) return refuse();
    if (tok.type === 'num') return this.make({ k: 'num', v: this.step().value });
    if (tok.type === 'str') return this.make({ k: 'str', v: this.step().value });
    if (tok.type === 'col') return this.make({ k: 'col', v: this.step().value });
    if (this.is('word', 'TODAY')) { this.at++; this.take('op', '('); this.take('op', ')'); return this.make({ k: 'today' }); }
    if (tok.type === 'word' && CONSTANTS.includes(tok.value)) return this.make({ k: 'const', v: this.step().value });
    if (this.is('op', '(')) { this.at++; const inner = this.or(depth + 1); this.take('op', ')'); return inner; }
    return refuse();
  }
  unary(depth) {
    if (this.is('op', '-')) { this.at++; return this.make({ k: 'neg', a: this.unary(depth + 1) }); }
    return this.atom(depth);
  }
  binary(next, ops, depth) {
    let left = next(depth);
    while (this.list[this.at] && this.list[this.at].type === 'op' && ops.includes(this.list[this.at].value)) {
      const op = this.step().value;
      left = this.make({ k: 'bin', op, a: left, b: next(depth) });
    }
    return left;
  }
  product(depth) { return this.binary(d => this.unary(d), ['*', '/'], depth); }
  sum(depth) { return this.binary(d => this.product(d), ['+', '-'], depth); }
  comparison(depth) {
    const left = this.sum(depth);
    if (this.list[this.at] && this.list[this.at].type === 'op' && COMPARE.has(this.list[this.at].value)) {
      const op = this.step().value;
      return this.make({ k: 'cmp', op, a: left, b: this.sum(depth) });
    }
    if (this.is('word', 'in') || (this.is('word', 'not') && this.list[this.at + 1] && this.list[this.at + 1].value === 'in')) {
      const negated = this.is('word', 'not') && ++this.at;
      this.take('word', 'in');
      return this.make({ k: 'in', not: Boolean(negated), a: left, list: this.items() });
    }
    if (this.is('word', 'is')) {
      this.at++;
      const negated = this.is('word', 'not') && ++this.at;
      this.take('word', 'None');
      return this.make({ k: 'isnone', not: Boolean(negated), a: left });
    }
    return left;
  }
  not(depth) {
    if (depth > DEPTH_MAX) refuse();
    if (this.is('word', 'not')) { this.at++; return this.make({ k: 'not', a: this.not(depth + 1) }); }
    return this.comparison(depth);
  }
  and(depth) {
    let left = this.not(depth);
    while (this.is('word', 'and')) { this.at++; left = this.make({ k: 'and', a: left, b: this.not(depth) }); }
    return left;
  }
  or(depth) {
    let left = this.and(depth);
    while (this.is('word', 'or')) { this.at++; left = this.make({ k: 'or', a: left, b: this.and(depth) }); }
    return left;
  }
  run() {
    const tree = this.or(0);
    if (this.at !== this.list.length) refuse();
    return tree;
  }
}

// Arbre d'une règle, ou null si elle sort de la grammaire (texte trop long, jeton inconnu…).
export function parseRule(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > RULE_MAX) return null;
  try {
    return new Parser(tokens(text.trim())).run();
  } catch (e) {
    if (e instanceof Refused) return null;
    throw e;
  }
}

// Colonnes qu'une règle lit (arbre de parseRule).
export function ruleRefs(tree) {
  const found = new Set();
  const walk = (node) => {
    if (!node) return;
    if (node.k === 'col') found.add(node.v);
    walk(node.a);
    walk(node.b);
  };
  walk(tree);
  return [...found];
}

// Priorité d'un nœud (comme Python) : le texte écrit ne met de parenthèses que là où elles changent le sens,
// et autour d'un et/ou imbriqué dans un autre (pour la lecture).
const LEVEL = { or: 1, and: 2, not: 3, cmp: 4, in: 4, isnone: 4, neg: 7 };
const levelOf = node => (node.k === 'bin' ? (node.op === '+' || node.op === '-' ? 5 : 6) : LEVEL[node.k] || 9);

// Opérandes d'une suite de `and` ou de `or` (l'arbre est penché à gauche).
const chain = (node, kind) => (node.k === kind ? [...chain(node.a, kind), node.b] : [node]);

function show(node, name, min = 0) {
  const text = body(node, name);
  return levelOf(node) < min ? `(${text})` : text;
}
const shown = (node, name) => show(node.a, name, 5);
const joined = (node, name) => chain(node, node.k).map(operand => show(operand, name, 3)).join(` ${node.k} `);
const SHOWERS = {
  num: node => node.v,
  str: node => `"${node.v}"`,
  const: node => node.v,
  col: (node, name) => `$${name(node.v)}`,
  today: () => 'TODAY()',
  neg: (node, name) => `-${show(node.a, name, 7)}`,
  not: (node, name) => `not ${show(node.a, name, 3)}`,
  and: joined,
  or: joined,
  in: (node, name) => `${shown(node, name)} ${node.not ? 'not in' : 'in'} [${node.list.map(v => show(v, name)).join(', ')}]`,
  isnone: (node, name) => `${shown(node, name)} is ${node.not ? 'not ' : ''}None`,
  cmp: (node, name) => `${shown(node, name)} ${node.op} ${show(node.b, name, 5)}`,
};
function showBinary(node, name) {
  const wide = node.op === '+' || node.op === '-' ? 5 : 6;
  return `${show(node.a, name, wide)} ${node.op} ${show(node.b, name, wide + 1)}`;
}
const body = (node, name) => (Object.hasOwn(SHOWERS, node.k) ? SHOWERS[node.k] : showBinary)(node, name);

// La formule d'un arbre, écrite par nous : seules des colonnes (`rename(nom)` rend leur nom dans le
// document qui l'écrit, ou null si elle n'y est pas : la règle est alors laissée), des nombres, des
// chaînes sûres, des constantes et des opérateurs y figurent. Null si une colonne manque.
export function printRule(tree, rename = id => id) {
  if (!tree) return null;
  const missing = ruleRefs(tree).some(id => !rename(id));
  return missing ? null : show(tree, id => rename(id));
}

// Règle ramenée à sa forme d'écriture, ou null : `normalizeRule(x)` est stable (la relire redonne le même texte).
export const normalizeRule = (text) => {
  const tree = parseRule(text);
  return tree ? printRule(tree) : null;
};
