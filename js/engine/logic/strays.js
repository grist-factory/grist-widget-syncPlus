// Logique pure : la table Synchro est-elle celle du widget, a-t-elle des colonnes qui ne sont pas à
// lui, et quelle colonne un envoi refusé nomme-t-il ? (Ni DOM, ni `grist`, ni réseau.)
//
// Le webhook d'un destinataire envoie la ligne entière de Synchro, toutes colonnes comprises, et le
// journal de la CIBLE refuse toute clé qui n'est pas une de ses colonnes (400 « Invalid column »,
// qui ne nomme que la première) : une colonne de plus dans Synchro bloque donc tous les envois. Cas
// vu avec la 0.5.9 : une table nommée Synchro faite à la main pour y poser le widget (colonnes A, B,
// C de Grist), reprise par le widget, qui n'y retirait rien.
import { EXPORT_COL, SYNC_TABLE, isBlank } from './common.js';
import { conditionExport } from './exports.js';
import { syncColumns } from './formulas.js';

const SORT_COL = 'manualSort'; // colonne d'ordre de toute table Grist (voir ensureSyncTable)
const HELPER = /^gristHelper_/; // colonnes cachées de Grist (texte affiché d'une Référence...)

// Synchro est la table du widget quand elle a sa colonne Synchro_Export (là où les exports sont
// notés) ; une table de ce nom sans cette colonne est celle de quelqu'un d'autre : le widget ne la
// reprend pas. `schema` : voir readSchema.
export const ownsSync = schema => schema.has(SYNC_TABLE) && schema.columns(SYNC_TABLE).some(c => c.colId === EXPORT_COL);
export const foreignSync = schema => schema.has(SYNC_TABLE) && !ownsSync(schema);

// Table Synchro disparue : la mémoire du widget (liste des exports, clés de signature des destinataires) n'est
// plus lisible, mais les webhooks des destinataires restent chez Grist, avec leur condition d'export (vérifié :
// une table effacée laisse ses webhooks sans table, une table renommée les garde et ils la suivent). C'est ce qui
// prouve que le widget était là. `hooks` et `conditions` : voir readHooks (propriétaires seulement).
//  - `hidden` : la table porte toujours le nom Synchro, mais le widget n'y retrouve plus Synchro_Export (colonne
//    effacée, ou illisible pour tout le monde par une règle d'accès) ;
//  - `renamed` : elle a un autre nom (`name`) ;
//  - `deleted` : elle n'existe plus.
// Rend null quand Synchro est bien celle du widget, ou qu'aucun webhook du widget ne reste.
export function lostSync(schema, hooks, conditions) {
  if (ownsSync(schema)) return null;
  const own = hooks.filter(h => conditionExport(conditions.get(h.id)));
  if (!own.length) return null;
  const names = own.map(h => h.fields.tableId || '');
  const renamed = names.find(name => name && name !== SYNC_TABLE);
  const kind = names.includes(SYNC_TABLE) ? 'hidden' : renamed ? 'renamed' : 'deleted';
  return { kind, name: kind === 'renamed' ? renamed : '', hooks: own.map(h => h.id) };
}

// Noms des colonnes que le widget donne à Synchro.
export const syncColumnIds = () => new Set(syncColumns([]).map(c => c.id));

// Une cellule qui dit quelque chose : ni vide, ni la valeur par défaut d'un type (0, faux), ni une
// liste vide (['L']).
const hasValue = v => !(isBlank(v) || v === 0 || v === false || (Array.isArray(v) && v.length <= 1));

// Colonnes de Synchro qui ne sont pas au widget (`columns` : celles de la table, voir readSchema ;
// `rows` : ses lignes). Chaque colonne dit combien de cellules contiennent une valeur (`filled`), et
// sa formule : une colonne à formule n'a pas de valeurs à sauvegarder, mais la formule oui.
export function strayColumns(columns, rows = []) {
  const known = syncColumnIds();
  return columns.filter(c => !known.has(c.colId) && c.colId !== SORT_COL && !HELPER.test(c.colId)).map((c) => {
    const formula = c.isFormula ? String(c.formula || '').trim() : '';
    return {
      id: c.colId, label: c.label || c.colId, type: c.type || 'Any', formula,
      filled: c.isFormula ? 0 : rows.filter(r => hasValue(r[c.colId])).length,
    };
  });
}

// Il y a quelque chose à perdre : des valeurs, ou une formule.
export const hasContent = stray => stray.filled > 0 || stray.formula !== '';

// Colonne que refuse le journal d'un destinataire, lue dans l'état d'envoi de son webhook (`usage`) :
// `{"error":"Invalid column \"A\""}` donne « A ». Vide si l'erreur est autre.
export function refusedColumn(usage) {
  const found = /Invalid column\s*\\*"([^"\\]+)/i.exec((usage || {}).lastErrorMessage || '');
  return found ? found[1] : '';
}

// D'où vient la colonne refusée : 'stray' (elle est dans Synchro et n'est pas au widget : à retirer),
// 'gone' (elle n'est plus dans Synchro, mais la file d'envoi garde d'anciens envois qui la portent),
// '' (une colonne du widget que ce journal n'a pas : il se remet à jour à l'ouverture de son widget,
// ou une autre erreur). `inSync` : colonnes actuelles de Synchro.
export function columnFault(usage, inSync) {
  const column = refusedColumn(usage);
  if (!column || syncColumnIds().has(column)) return '';
  return inSync.includes(column) ? 'stray' : 'gone';
}

// Nom libre pour la table d'une personne que le widget ne reprend pas : « Table_Synchro », puis
// « Table_Synchro2 »... (Grist ne distingue pas les majuscules ; un nom en « Synchro_ » serait
// écarté des tables d'utilisateur, voir isUserTable ; avec un préfixe de tables, « Table_ » suivi
// du nom de la table technique.) `taken` : noms de tables du document.
export function freeTableName(taken, base = `Table_${SYNC_TABLE}`) {
  const used = new Set([...taken].map(name => name.toLowerCase()));
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}${n}`;
  return name;
}

// Nom de table que Grist accepte sans le changer : lettres, chiffres et « _ », sans commencer par un
// chiffre. Rend le problème (clé du texte) ou ''.
export function tableNameProblem(name, taken) {
  const text = String(name || '').trim();
  if (!text) return 'empty';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) return 'invalid';
  if ([...taken].some(other => other.toLowerCase() === text.toLowerCase())) return 'taken';
  return '';
}
