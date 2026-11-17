// CIBLE : adopter une table qui existe déjà, avec ses colonnes et ses lignes. Deux choses se disent avant d'écrire :
//  - le type de chaque colonne d'ici qui reçoit une colonne envoyée (`fitIssues`) : une valeur qui ne convient pas à son
//    type est gardée par Grist mais marquée invalide, ou n'est plus utilisable (Référence, pièces jointes) ;
//  - ce que la première recopie ferait des lignes déjà là (`adoptionPreview`) : lignes ajoutées, lignes d'ici rattachées à
//    une ligne de la SOURCE par la colonne commune, valeurs d'ici remplacées, cellules vides remplies, lignes qui ne bougent pas.
// Une réception qui demande l'accord (`ask`, voir structure.js) n'écrit pas dans une table qui existait avant elle tant que
// la personne n'a pas vu cet aperçu (`adoptionStep`). Une réception qui applique tout seule, et toute réception d'avant,
// recopie comme avant.
import { KEY_COL, isBlank } from './common.js';
import { sameValue } from './consolidation.js';
import { destColumns } from './journal.js';

const base = type => String(type || '').split(':')[0];
const REFS = new Set(['Ref', 'RefList']);
const SYSTEM = new Set(['Id', 'PositionNumber', 'ManualSortPos']);

// Ce que vaut l'écriture d'une colonne envoyée (type `sent`) dans une colonne d'ici (type `here`) :
// 'same' (même type), 'fine' (Grist garde la valeur telle quelle), 'risky' (des valeurs peuvent être marquées invalides par
// Grist, ou s'afficher autrement), 'bad' (le type ne reçoit pas ces valeurs : Référence, pièces jointes, colonne du système).
export function typeFit(sent, here) {
  const [s, h] = [base(sent), base(here)];
  if (s === h) return 'same';
  if (h === 'Any') return 'fine';
  if (s === 'Attachments' || h === 'Attachments' || REFS.has(h) || SYSTEM.has(h)) return 'bad';
  if (h === 'Text') return s === 'ChoiceList' || s === 'Date' || s === 'DateTime' ? 'risky' : 'fine';
  if (h === 'Choice') return s === 'Text' ? 'fine' : 'risky';
  if (h === 'Numeric') return s === 'Int' ? 'fine' : 'risky';
  return 'risky';
}

// Les colonnes envoyées (`columns`, avec leur type) dont la colonne d'ici (`map` : nom envoyé -> nom d'ici, le même par
// défaut ; `here` : colonnes de la destination avec leur type) n'a pas un type qui leur convient :
// [{ id, to, sent, here, level }], `level` valant 'risky' ou 'bad'. Une colonne qui n'existe pas encore sera créée au bon type.
export function fitIssues(columns, map, here) {
  const byName = new Map(here.map(c => [c.colId, c]));
  return destColumns(columns).flatMap((c) => {
    const to = (map || {})[c.id] || c.id;
    const column = byName.get(to);
    const level = column ? typeFit(c.type, column.type) : 'same';
    return level === 'risky' || level === 'bad' ? [{ id: c.id, to, sent: c.type, here: column.type, level }] : [];
  });
}

// Faut-il écrire dans cette table ? `entry.adopt` : la destination existait avant la réception (notée quand la réception
// demande l'accord) ; `entry.adopted` : sa première recopie est faite ou décidée. 'go' (rien de particulier), 'mark' (écrire et
// noter `adopted` : la réception applique seule, la personne a accepté, ou la destination est vide) ou 'hold' (rien n'est
// écrit tant que la personne n'a pas accepté : seulement si la recopie écrirait quelque chose, voir copyTable).
export function adoptionStep({ ask, approve }, entry, destRows) {
  if (!entry.adopt || entry.adopted) return 'go';
  if (!ask || approve || !destRows.length) return 'mark';
  return 'hold';
}

const SHOWN = 40;
const clip = value => {
  const text = Array.isArray(value) ? value.filter(x => x !== 'L').join(', ') : String(value ?? '');
  return text.length > SHOWN ? `${text.slice(0, SHOWN - 1)}…` : text;
};
const SAMPLES = 3;

// Ce que ferait la première recopie (`plan` : rendu par planConsolidation) dans une table qui a déjà des lignes :
// { added, attached, overwritten, filled, untouched, match, samples }. `attached` : lignes d'ici sans clé qui ont la même valeur
// que celle d'une ligne reçue dans la colonne commune (`entry.match`) et prennent ses valeurs ; `overwritten` : valeurs d'ici
// non vides remplacées ; `filled` : cellules vides remplies ; `untouched` : lignes d'ici sans clé qui ne bougent pas.
export function adoptionPreview(plan, { copyCols, destRows, match = '' }) {
  const cells = plan.attached.map(([row, version]) => {
    const differ = copyCols.filter(([from, to]) => !sameValue(version.row[from], row[to]));
    const [over, fill] = [differ.filter(([, to]) => !isBlank(row[to])), differ.filter(([, to]) => isBlank(row[to]))];
    return { row, version, over, fill };
  });
  const unkeyed = destRows.filter(r => isBlank(r[KEY_COL])).length;
  return {
    added: plan.stats.added, attached: cells.length, match,
    overwritten: cells.reduce((sum, c) => sum + c.over.length, 0), filled: cells.reduce((sum, c) => sum + c.fill.length, 0),
    untouched: Math.max(0, unkeyed - cells.length),
    samples: cells.filter(c => c.over.length).slice(0, SAMPLES).map(({ row, version, over: [[from, to]] }) => ({
      key: clip(row[match]), col: to, here: clip(row[to]), sent: clip(version.row[from]),
    })),
  };
}
