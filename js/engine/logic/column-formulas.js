// Formules des colonnes, que la SOURCE peut envoyer avec ses colonnes (case « Formules » de l'assistant d'export,
// à part, jamais cochée d'emblée) et que la CIBLE ne pose que sur le clic d'un propriétaire, après lecture.
//
// Une formule est du Python que Grist exécute sur les données du document. Rien de ce fichier ne l'interprète : il la
// nettoie, la borne, la lit pour dire à la personne ce qu'elle cite (colonnes, tables) et refuse d'office ce qui n'a rien à
// faire dans une formule de colonne (modules système, accès aux entrailles de Python). Ce n'est pas une garantie : le
// bac à sable de Grist et la lecture de la personne restent les vraies protections (SECURITY.md).
//
// Dans la description signée des colonnes (`Synchro_Colonnes`) : `fx` (texte de la formule, vide pour une colonne qui
// n'est pas une formule) sur chaque colonne d'un export qui envoie les formules. La présence de la clé dit que l'export
// les envoie, même vide. `fd` (seulement quand il y en a une) : la formule par défaut d'une colonne de données, c'est-à-dire
// une formule de déclenchement « sur les nouvelles lignes » seulement (voir sourceDefault).
import { KEY_COL } from './common.js';
import { destContext } from './schema.js';

// Longueur maximale d'une formule, et de toutes celles d'une table de l'export (la description des colonnes part avec
// chaque envoi : 20 000 caractères restent loin du mégaoctet que Grist accepte). Une formule trop longue n'est pas
// coupée (un Python tronqué n'est plus le même programme) : elle ne part pas.
export const FORMULA_MAX = 1500;
export const FORMULAS_TOTAL_MAX = 20000;

// Texte d'une formule, nettoyé : sans caractères de contrôle (sauf le retour à la ligne et la tabulation, qui comptent en
// Python) ni de sens d'écriture ou invisibles (un U+202E ferait lire autre chose que ce que Python exécute), retours
// à la ligne unifiés, espaces de fin retirées. Un texte qui n'en est pas un, vide ou trop long donne ''.
export function cleanFormula(text, max = FORMULA_MAX) {
  if (typeof text !== 'string') return '';
  const clean = text.replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/[ \t]+\n/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return [...clean].length > max ? '' : clean;
}

// Une Référence ou une colonne de pièces jointes part comme du texte : sa formule rendrait une fiche ou des fichiers,
// pas du texte. Elle ne part pas.
const CONVERTED = /^(Ref(List)?:|Attachments$)/;

// Formule envoyée pour la colonne `col` du schéma de la SOURCE : celle d'une vraie colonne de formule (pas d'une
// colonne de données à formule de déclenchement), nettoyée ; '' sinon.
export function sourceFormula(col) {
  if (!col || !col.isFormula || CONVERTED.test(col.type || '')) return '';
  return cleanFormula(col.formula);
}

// Formule par défaut de la colonne de données `col` : sa formule de déclenchement quand elle ne joue que sur les **nouvelles
// lignes** (`recalcWhen` 0, aucune colonne suivie), nettoyée ; '' sinon. Vérifié dans Grist 1.7 : une telle formule ne remplit
// qu'une cellule que l'ajout ne donne pas (une valeur donnée, même vide, l'emporte), ne touche jamais aux lignes déjà là ; la
// recopie de la CIBLE, qui écrit chaque colonne, ne la déclenche donc jamais. Une formule qui se recalcule quand une colonne
// change (ou à toute modification) ne part pas : elle réécrirait ici des valeurs que la SOURCE envoie déjà, et la carte les
// signalerait comme retouchées. Même exclusion que pour les formules de colonne : Référence et Pièces jointes.
export function sourceDefault(col) {
  if (!col || col.isFormula || CONVERTED.test(col.type || '')) return '';
  if (col.recalcWhen && col.recalcWhen !== 0) return '';
  if (Array.isArray(col.recalcDeps) && col.recalcDeps.length > 1) return '';
  return cleanFormula(col.formula);
}

// Les colonnes exportées `columns` avec leur formule (`fx`), et leur formule par défaut (`fd`, seulement s'il y en a une),
// d'après les colonnes du schéma `live`. Au-delà de `FORMULAS_TOTAL_MAX` caractères pour la table, les formules suivantes ne
// partent pas.
export function withFormulas(columns, live) {
  const here = new Map((live || []).map(c => [c.colId, c]));
  let total = 0;
  const fit = (formula) => {
    const sent = formula && total + formula.length <= FORMULAS_TOTAL_MAX ? formula : '';
    total += sent.length;
    return sent;
  };
  return columns.map(({ fx, fd, ...c }) => {
    const col = here.get(c.id);
    const formula = fit(col ? sourceFormula(col) : '');
    const initial = fit(col ? sourceDefault(col) : '');
    return { ...c, fx: formula, ...(initial ? { fd: initial } : {}) };
  });
}

// Colonnes qui portent une formule envoyée (de colonne ou par défaut), et ce que dit la liste : l'export envoie les formules
// (`offered`, même s'il n'y en a aucune), et il y en a au moins une (`sent`).
const hasText = value => typeof value === 'string' && value !== '';
export const formulaItems = columns => (Array.isArray(columns) ? columns : []).filter(c => c && (hasText(c.fx) || hasText(c.fd)));
export const formulasOffered = columns => (Array.isArray(columns) ? columns : []).some(c => c && typeof c.fx === 'string');
export const formulasSent = columns => formulaItems(columns).length > 0;

// ---------------------------------------------------------------------------------------------
// CIBLE : lire une formule avant de la poser

// Modules qu'une formule peut importer : calcul, dates, texte. Tout autre est refusé (système, réseau, fichiers). `string` (son
// `Formatter().get_field` lit un attribut par son nom : un `getattr` déguisé) et `fractions` (qui montre `operator`) n'y sont
// plus depuis la 0.30.4.
export const SAFE_MODULES = ['math', 'datetime', 'time', 'calendar', 're', 'json', 'decimal', 'statistics',
  'itertools', 'functools', 'collections', 'random', 'unicodedata'];

// Mots qui n'ont rien à faire dans une formule de colonne, cherchés hors des textes entre guillemets et des commentaires
// (« open » est un statut possible) et hors des colonnes citées (`$open`, `rec.open`). Quatre familles :
//  - exécuter du texte ou lire un nom calculé : `eval`, `getattr`, et ses frères (`attrgetter`, `methodcaller` du module `operator`,
//    `Formatter` et `get_field` du module `string` rendent l'attribut qu'on leur nomme) ;
//  - fichiers, système et réseau : modules et fonctions ; `REQUEST` est la fonction de Grist qui appelle une adresse du
//    réseau (elle marche si l'instance l'a activée : une formule y enverrait le contenu de la table à n'importe quel site) ;
//  - ce que les modules permis laissent atteindre (relevé en parcourant leurs attributs) : `operator`, `codecs`, `copyreg`, `enum`
//    et `bltns` (ses `builtins`), `sys`, `os` ;
//  - l'intérieur de Grist (`grist`, `docmodel`, `engine`, `sandbox`) et ce qui bloque le calcul de tout le document
//    (`while` : une boucle sans fin ; `sleep`, `exit`, `quit`).
// Les doubles tirets bas et tout nom qui commence par un tiret bas le sont à part (`forbiddenProblems`).
const FORBIDDEN = /\b(?:eval|exec|compile|open|input|breakpoint|help|exit|quit|getattr|setattr|delattr|globals|locals|vars|memoryview|attrgetter|methodcaller|Formatter|vformat|get_field|import_module|os|sys|subprocess|socket|urllib|requests|http|ftplib|smtplib|ctypes|importlib|pickle|shelve|shutil|pathlib|builtins|bltns|inspect|gc|signal|threading|multiprocessing|asyncio|operator|codecs|copyreg|enum|monitoring|REQUEST|Response|HTTPError|grist|docmodel|engine|sandbox|while|sleep)\b/g;

// La formule sans ses commentaires ni le contenu de ses textes (remplacé par `""`), pour la lire sans prendre un mot d'un
// texte pour du code. Le contenu d'un texte f"…" reste : Python y exécute ce qui est entre accolades. Un texte simple
// s'arrête à la fin de la ligne (Python ne le laisse pas la dépasser) : rien de ce qui suit n'est caché.
function stripStrings(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (ch === '"' || ch === "'") {
      const { body, end } = readString(src, i);
      const prefix = /([A-Za-z]{1,2})$/.exec(out);
      out += prefix && /f/i.test(prefix[1]) ? ` ${body} ` : '""';
      i = end;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

// Le texte qui s'ouvre en `start` : son contenu et la position qui suit sa fin.
function readString(src, start) {
  const quote = src.startsWith(src[start].repeat(3), start) ? src[start].repeat(3) : src[start];
  let end = start + quote.length;
  while (end < src.length && !src.startsWith(quote, end) && !(quote.length === 1 && src[end] === '\n')) end += src[end] === '\\' ? 2 : 1;
  return { body: src.slice(start + quote.length, end), end: src.startsWith(quote, end) ? end + quote.length : end };
}

// Modules cités par les `import …` et `from … import …` (où qu'ils soient dans la ligne : après un `;` ou un `:` aussi).
function importedModules(code) {
  const found = [...code.matchAll(/\bfrom\s+([A-Za-z_][\w.]*)\s+import\b/g)].map(m => m[1].split('.')[0]);
  const rest = code.replace(/\bfrom\s+[A-Za-z_][\w.]*\s+import\b[^\n;]*/g, ' ');
  for (const m of rest.matchAll(/\bimport\s+([^\n;]+)/g)) {
    found.push(...m[1].split(',').map(part => part.trim().split(/\s+as\s+/)[0].split('.')[0]).filter(Boolean));
  }
  return found;
}

const unique = list => list.filter((p, i) => list.findIndex(q => q.code === p.code && q.name === p.name) === i);

// Ce qui empêche de poser la formule `formula` d'une colonne de la table reçue, en liste de `{ code, name, to? }` (vide :
// rien à signaler). `here` : colonnes de la destination ; `map` : correspondance des colonnes envoyées (nom de la SOURCE vers
// celui d'ici) ; `tables` : tables de l'export, du nom de la SOURCE vers celui d'ici ; `every` : toutes les tables d'ici (résumés compris).
//  - `unsafe` : mot interdit, nom privé (tiret bas en tête) ou caractère hors ASCII (`name`) ; `import` : module hors de la liste (`name`) ;
//  - `missingCol` : colonne citée (`$Nom`, `rec.Nom`) absente d'ici ; `renamedCol` : elle s'appelle `to` ici ;
//  - `foreignTable` : table citée qui n'est pas une table de l'export (`Nom.lookupRecords`, `.lookup_one`, `.all`, ou son nom
//    seul : `len(Nom)`, `for r in Nom`) ; `renamedTable` : elle s'appelle `to` ici.
// Une formule qui cite une colonne ou une table renommée n'est pas réécrite (Python n'est pas réécrit à l'aveugle) : la
// personne la corrige à la main si elle le veut. **Un garde-fou, pas une preuve** : la propriété qui compte est que la
// formule n'est jamais posée sans le clic d'un propriétaire qui l'a lue, et que l'isolation du code des formules est celle de
// l'instance (`GRIST_SANDBOX_FLAVOR`).
export function formulaProblems(formula, { here, map = {}, tables = new Map(), every = new Set() }) {
  const code = stripStrings(formula);
  return unique([...forbiddenProblems(formula, code), ...referenceProblems(code, { here, map, tables, every })]);
}

// Le texte que Python lira : ses identifiants sont normalisés en NFKC (« ｅｖａｌ » en pleine largeur est `eval`), et les colonnes
// citées (`$Nom`, `rec.Nom`, sauf un nom privé) y sont remplacées : un nom de colonne n'est pas un mot de code.
const COLUMN_REF = /\$\s*([A-Za-z]\w*)|\brec\s*\.\s*([A-Za-z]\w*)/g;
const withoutColumns = code => code.normalize('NFKC').replace(COLUMN_REF, ' COLUMN ');

// Mots, noms privés et modules refusés (`formula` : le texte entier, pour les doubles tirets bas ; `code` : sans textes ni commentaires).
function forbiddenProblems(formula, code) {
  const problems = formula.includes('__') ? [{ code: 'unsafe', name: '__' }] : [];
  for (const odd of new Set(code.match(/[^\x00-\x7f]+/g) || [])) problems.push({ code: 'unsafe', name: odd.slice(0, 40) }); // dit à la personne : 40 caractères au plus
  const bare = withoutColumns(code);
  for (const word of new Set(bare.match(FORBIDDEN) || [])) problems.push({ code: 'unsafe', name: word });
  for (const hidden of new Set(bare.match(/\b_\w+/g) || [])) problems.push({ code: 'unsafe', name: hidden });
  const flagged = new Set(problems.map(p => p.name));
  for (const module of new Set(importedModules(bare))) if (!SAFE_MODULES.includes(module) && !flagged.has(module)) problems.push({ code: 'import', name: module });
  return problems;
}

// Colonnes (`$Nom`, `rec.Nom`) et tables citées, à lire chez la CIBLE. Une table se lit par `Nom.lookupRecords`, `.lookupOne`,
// `.lookup_records`, `.all`… ou se nomme seule : toute table d'ici qui n'est pas dans l'export est refusée, quelle que soit la façon de la lire.
function referenceProblems(code, { here, map, tables, every }) {
  const text = code.normalize('NFKC');
  const problems = [];
  const names = [...text.matchAll(/\$\s*([A-Za-z_]\w*)/g), ...text.matchAll(/\brec\s*\.\s*([A-Za-z_]\w*)/g)].map(m => m[1]);
  for (const name of names.filter(n => n !== 'id')) {
    const to = map[name] || name;
    if (to !== name) problems.push({ code: 'renamedCol', name, to });
    else if (!here.has(name)) problems.push({ code: 'missingCol', name });
  }
  const bare = text.replace(/\$\s*[A-Za-z_]\w*|\brec\s*\.\s*[A-Za-z_]\w*/g, ' ');
  const cited = new Set([...bare.matchAll(/(?<![.\w])([A-Z]\w*)\s*\.\s*(?:lookup\w*|all)\b/g)].map(m => m[1]));  // un identifiant de table commence par une majuscule
  for (const m of bare.matchAll(/(?<![.\w])([A-Za-z_]\w*)\b(?!\s*=(?!=))/g)) if (every.has(m[1]) || tables.has(m[1])) cited.add(m[1]);
  for (const name of cited) {
    const to = tables.get(name);
    if (to === undefined) problems.push({ code: 'foreignTable', name });
    else if (to !== name) problems.push({ code: 'renamedTable', name, to });
  }
  return problems;
}

// Où en est la colonne d'ici : 'same' (la formule est déjà posée), 'other' (une autre formule est là), 'data' (aucune).
function placed(column, kind, formula) {
  if (kind === 'column') return !column.isFormula ? 'data' : column.formula === formula ? 'same' : 'other';
  if (column.isFormula || !column.formula) return 'data';
  return column.formula === formula && !column.recalcWhen && !(Array.isArray(column.recalcDeps) && column.recalcDeps.length > 1) ? 'same' : 'other';
}

// Les formules à poser dans la destination `entry.dest` (voir la note de l'entrée : `own`, `map`). Une formule ne remplace
// jamais que ce que le widget a créé (`own`) : une colonne qui existait déjà ici garde ses données. `columns` : colonnes envoyées
// (avec `fx`) ; `tables` : voir formulaProblems. Rend `items`, une ligne par formule envoyée dont la colonne existe ici :
// `{ id, to, label, formula, state, problems, ok, applied }` où `state` vaut 'data' (colonne de données ici), 'other' (autre
// formule ici) ou 'same' (déjà posée), et `ok` dit que rien ne s'y oppose. `actions` : les écritures, seulement avec `replace`
// (le clic d'un propriétaire) : `ModifyColumn` en colonne de formule, pour les formules sans objection qui ne sont pas déjà là.
// Une formule par défaut (`kind: 'default'`) ne remplace aucune valeur : la colonne reste de données, elle reçoit la formule de
// déclenchement « sur les nouvelles lignes » (`state` : 'data' sans formule par défaut ici, 'other' une autre, 'same' déjà posée) ;
// une colonne qui est de formule ici n'est pas transformée (`formulaHere`).
export function planFormulas(schema, entry, columns, { tables = new Map(), replace = false } = {}) {
  const context = { entry, ...destContext(schema, entry), tables, every: new Set(schema.everyTableId || schema.tableIds || []), replace };
  const items = [];
  const actions = [];
  for (const sent of formulaItems(columns)) {
    const planned = planFormula(sent, context);
    if (!planned) continue;
    if (planned.action) actions.push(planned.action);
    items.push(planned.item);
  }
  return { items, actions };
}

// Une formule envoyée : sa ligne pour la carte et, avec `replace` et sans objection, l'écriture qui la pose (null : la colonne n'existe pas ici).
function planFormula(c, { entry, here, own, map, tables, every, replace }) {
  const kind = hasText(c.fx) ? 'column' : 'default';
  const formula = cleanFormula(kind === 'column' ? c.fx : c.fd);
  const to = map[c.id] || c.id;
  const column = here.get(to);
  if (!formula || !column || to === KEY_COL) return null;
  const problems = objections({ formula, kind, column, to, owned: own.has(c.id) }, { here, map, tables, every });
  const state = placed(column, kind, formula);
  const ok = !problems.length;
  const applied = replace && ok && state !== 'same';
  return { action: applied ? formulaWrite(entry.dest, to, kind, formula) : null, item: { id: c.id, to, label: c.label || c.id, formula, kind, state: applied ? 'same' : state, problems, ok, applied } };
}

// Ce qui s'oppose à poser la formule : sa lecture (formulaProblems), une colonne que le widget n'a pas créée, une colonne déjà de formule ici.
function objections({ formula, kind, column, to, owned }, { here, map, tables, every }) {
  const problems = formulaProblems(formula, { here, map, tables, every });
  if (!owned) problems.unshift({ code: 'notOwn', name: to });
  if (kind === 'default' && column.isFormula) problems.unshift({ code: 'formulaHere', name: to });
  return problems;
}

const formulaWrite = (dest, to, kind, formula) => ['ModifyColumn', dest, to, kind === 'column' ? { isFormula: true, formula } : { isFormula: false, formula, recalcWhen: 0 }];
