// SOURCE : les formules de la table Synchro, et les colonnes que le widget ajoute aux tables
// envoyées (clé, MajLe, RecalculLe, Supprime).
import {
  AUTHOR_COL, BUCKETS, COL_ID, DELETE_COL, EXPORT_COL, KEY_COL, KIND, LIST_COL, LOT_COL, MISSING_COL, ORDER_COL, RECALC_COL, RESEND_COL, SCHEMA_COL,
  SYNC_TABLE, TABLE_COL, TRACK_COL, TYPE_COL, chunk, isBlank,
} from './common.js';

const WINDOW_S = 5; // un lot porte les lignes modifiées depuis 5 secondes
// Au chargement du document, Grist recalcule RECALC_COL pour toutes les lignes : ce n'est pas une
// annulation, sauf dans une petite table, renvoyée alors en entier (quelques lignes).
const SMALL_TABLE = 20;
// Octets d'un lot. Grist refuse un envoi de plus de 1 Mo, et un même envoi regroupe les listes des
// clés et les lots des tables d'un export qui changent ensemble : chaque lot prend sa part de ce
// que les listes laissent.
const LOT_MAX = 250000;
const POST_MAX = 950000;
const LOT_MIN = 20000;
// Instantané d'un export public, relu par chaque page CIBLE ouverte quand il change : au-delà, il
// reste vide et la CIBLE dit que la table est trop grosse pour le lien public.
const PUBLIC_MAX = 2000000;
// Le suivi ne garde qu'une somme de CRC-32 par seau de clés, de taille fixe quelle que soit la
// table (la liste de toutes les clés, réécrite à chaque ajout, faisait grossir l'historique du
// document de 1,5 Mo par ligne ajoutée sur 20 000 lignes ; les sommes, de quelques Ko, mesuré). Un
// seau qui perd une clé part en entier (ses clés restantes) ; au-delà de PART_KEYS clés à envoyer
// d'un coup, le widget SOURCE renvoie la liste complète, par morceaux de PART_KEYS clés. Une clé
// (UUID) fait une quarantaine d'octets : de quoi laisser la place aux lots.
const PART_KEYS = 5000;

// Lecture d'une valeur (`g`) et filtre de lignes de la table dans l'export (`keep`), communs aux
// formules : une ligne qui sort du filtre quitte les clés, la CIBLE l'efface. Une valeur est lue à
// part : une cellule en erreur part vide sans bloquer les autres. Dates en secondes (format de
// Grist), Référence par son texte affiché.
const READ = [
  'import json, datetime',
  'def v(x):',
  '  if isinstance(x, datetime.datetime): return x.timestamp()',
  '  if isinstance(x, datetime.date): return (x - datetime.date(1970, 1, 1)).days * 86400',
  '  if isinstance(x, (list, tuple)): return [v(y) for y in x]',
  '  return x if x is None or isinstance(x, (str, int, float, bool)) else str(x)',
  'def g(r, c):',
  '  try:',
  '    x, s, w = getattr(r, c["id"]), c.get("source", ""), c.get("visible", "")',
  '    if s.startswith("RefList:"): return ", ".join(str(getattr(y, w) if w else y.id) for y in x)',
  '    if s.startswith("Ref:"): return v(getattr(x, w) if w else x.id)',
  '    return v(x)',
  '  except Exception:',
  '    return None',
  'def txt(x):',
  '  if isinstance(x, bool): return "oui" if x else "non"',
  '  if isinstance(x, float) and x.is_integer(): x = int(x)',
  '  if isinstance(x, list): return ", ".join(txt(y) for y in x)',
  '  return "" if x is None else str(x).strip().lower()',
  `f = ${SYNC_TABLE}.lookupOne(${EXPORT_COL}=$${EXPORT_COL}, ${TABLE_COL}=$${TABLE_COL}, ${TYPE_COL}="${KIND.filter}")`,
  `spec = json.loads(f.${SCHEMA_COL} or "null") if f.id else None`,
  'def keep(r): return not spec or txt(g(r, spec)) == spec["value"]',
];

// Formules de la table Synchro. Elles nomment en clair les tables qu'elles peuvent lire (`tables`,
// qui doivent exister : une table inconnue mettrait toutes les lignes en erreur) : le widget les
// réécrit quand un export gagne ou perd une table. Leurs variables sont en minuscules, comme aucun
// nom de table Grist.
export function syncFormulas(tables) {
  const ids = [...new Set(tables)].filter(id => COL_ID.test(id)).sort();
  const pick = `tables = {${ids.map(id => `"${id}": ${id}`).join(', ')}}\nsrc = tables.get($${TABLE_COL})`;
  return { keys: keysFormula(pick), lot: lotFormula(pick), state: stateFormula(pick) };
}

// Synchro_Ids. Lignes 'cles' : ce qu'il faut envoyer de la liste, en JSON : les seaux qui ont perdu
// une clé (lus dans le suivi), et pendant un renvoi le morceau de la liste complète demandé dans
// Synchro_Renvoi ({ marque, n, apres }), à l'heure `t` du suivi. Lignes 'suivi' : le nombre de clés
// et la somme de leurs CRC-32, recalculés à chaque changement des clés, qui déclenchent le suivi.
// Lignes 'empreinte' : la taille et le CRC-32 de l'instantané public.
function keysFormula(pick) {
  return [
    // Empreinte de l'instantané public : la CIBLE ne relit l'instantané que si elle change.
    `if $${TYPE_COL} == "${KIND.mark}":`,
    '  import zlib',
    `  c = ${SYNC_TABLE}.lookupOne(${EXPORT_COL}=$${EXPORT_COL}, ${TABLE_COL}=$${TABLE_COL}, ${TYPE_COL}="${KIND.full}").${LOT_COL} or ""`,
    '  return "%d:%08x" % (len(c), zlib.crc32(c.encode()))',
    `if $${TYPE_COL} not in ("${KIND.keys}", "${KIND.track}"): return ""`,
    // Échange : l'autre document n'efface rien d'après la liste des clés, elle ne part pas.
    `if $${TYPE_COL} == "${KIND.keys}" and ${SYNC_TABLE}.lookupOne(${EXPORT_COL}=$${EXPORT_COL}, ${TYPE_COL}="${KIND.swap}").id: return ""`,
    pick, 'if src is None: return ""', ...READ,
    `if $${TYPE_COL} == "${KIND.track}":`,
    '  import zlib',
    `  sums = [zlib.crc32(str(r.${KEY_COL}).encode()) for r in src.all if r.${KEY_COL} and keep(r)]`,
    '  return "%d:%08x" % (len(sums), sum(sums) & 0xffffffff)',
    'import bisect',
    `s = ${SYNC_TABLE}.lookupOne(${EXPORT_COL}=$${EXPORT_COL}, ${TABLE_COL}=$${TABLE_COL}, ${TYPE_COL}="${KIND.track}")`,
    `state = json.loads(s.${TRACK_COL}) if s.id and isinstance(s.${TRACK_COL}, str) and s.${TRACK_COL}.startswith("{") else {}`,
    'out = {"t": state["t"], "seaux": state["seaux"]} if state.get("seaux") else {}',
    `ask = json.loads($${RESEND_COL}) if ($${RESEND_COL} or "").startswith("{") else None`,
    // Le morceau porte l'heure du suivi : les clés n'ont pas changé depuis (sinon le suivi aussi).
    'if ask and state.get("t"):',
    `  have = sorted(set(str(r.${KEY_COL}) for r in src.all if r.${KEY_COL} and keep(r)))`,
    '  i = bisect.bisect_right(have, str(ask.get("apres") or ""))',
    `  out["liste"] = {"marque": ask.get("marque"), "n": ask.get("n"), "t": state["t"], "cles": have[i:i + ${PART_KEYS}], "fin": i + ${PART_KEYS} >= len(have)}`,
    'return json.dumps(out) if out else ""',
  ].join('\n');
}

// Synchro_Lot. Lignes 'lot' : les lignes modifiées depuis WINDOW_S secondes et celles demandées
// dans Synchro_Renvoi, avec les colonnes de l'export, plafonné (`total` dit combien il y en avait).
// Un lot coupé dit depuis quand (`depuis`) : la marque MISSING_COL le retient, et le widget SOURCE
// envoie le reste. Lignes 'complet' (lien public) : toutes les lignes, au plus PUBLIC_MAX octets
// (au-delà, aucune : `trop`).
// Une ligne annulée (Ctrl+Z : MajLe revenue en arrière, RECALC_COL recalculée à l'instant) part
// avec l'heure de l'annulation, pour l'emporter sur la version qu'elle annule.
// Échange : la consolidation écrit les lignes reçues avec MajLe à l'heure de leur version, et
// touche dans le même lot d'écritures la ligne 'echange' de l'export, dont MISSING_COL prend alors
// l'heure. Grist recalcule tout le lot d'écritures d'un coup : une ligne recalculée à cette heure-là
// (à une seconde près) et dont MajLe est plus ancienne vient de l'autre document. Elle n'y repart
// pas (pas d'écho) ; vers les autres exports (relais), elle part avec l'heure de sa version. Une
// modification ici a une MajLe plus récente que la ligne 'echange' : elle part toujours.
// `Supprime` part telle quelle : la CIBLE la lit comme une case à cocher (« Non » ne supprime pas).
function lotFormula(pick) {
  return [
    `if $${TYPE_COL} not in ("${KIND.lot}", "${KIND.full}"): return ""`, pick, 'if src is None: return ""', ...READ,
    `cols = json.loads($${SCHEMA_COL} or "[]")`,
    `again = set(int(i) for i in ($${RESEND_COL} or "").split(":")[-1].split(",") if i.strip().isdigit())`,
    `rows = [r for r in src.all if r.${KEY_COL} and keep(r)]`,
    'undone = set()',
    `if $${TYPE_COL} == "${KIND.lot}":`,
    `  swap = ${SYNC_TABLE}.lookupOne(${EXPORT_COL}=$${EXPORT_COL}, ${TYPE_COL}="${KIND.swap}").id`,
    `  stamps = [x.${MISSING_COL} for x in ${SYNC_TABLE}.lookupRecords(${TYPE_COL}="${KIND.swap}") if isinstance(x.${MISSING_COL}, (int, float))]`,
    `  cut = NOW() - datetime.timedelta(seconds=${WINDOW_S})`,
    // Seule RECALC_COL (un nombre : lu vite) est lue sur toutes les lignes ; les dates, bien plus
    // lentes à lire, seulement sur les lignes recalculées depuis moins de WINDOW_S secondes.
    `  touched = [r for r in rows if (v(getattr(r, "${RECALC_COL}", None)) or 0) > v(cut)]`,
    '  def echo(r):',
    `    t, m = v(getattr(r, "${RECALC_COL}")) or 0, v(r.${ORDER_COL}) or 0`,
    '    return any(abs(t - s) < 1 and m < s for s in stamps)',
    `  recent = set(r.id for r in touched if r.${ORDER_COL} and r.${ORDER_COL} >= cut and not (swap and echo(r)))`,
    '  fresh = set() if swap else set(r.id for r in touched if r.id not in recent and echo(r))',
    '  undone = set(r.id for r in touched if r.id not in recent and r.id not in fresh and not echo(r))',
    // Toutes les lignes recalculées d'un coup : un rechargement du document, pas une annulation (une
    // petite table repart, sauf dans un Échange, où une version ancienne écraserait l'autre côté).
    `  if len(touched) == len(rows) > (0 if swap else ${SMALL_TABLE}): undone = set()`,
    '  rows = [r for r in rows if r.id in again or r.id in recent or r.id in undone or r.id in fresh]',
    `def when(r): return v(getattr(r, "${RECALC_COL}") if r.id in undone else r.${ORDER_COL})`,
    // Les listes de l'export partent dans le même envoi : chaque lot prend sa part de ce qu'elles laissent.
    `lists = ${SYNC_TABLE}.lookupRecords(${EXPORT_COL}=$${EXPORT_COL}, ${TYPE_COL}="${KIND.keys}")`,
    `room = ${POST_MAX} - sum(len(r.${LIST_COL} or "") for r in lists)`,
    `budget = max(${LOT_MIN}, min(${LOT_MAX}, room // max(1, len(lists))))`,
    `capped = $${TYPE_COL} == "${KIND.lot}"`,
    'out, size, big = [], 0, []',
    `for r in sorted(rows, key=lambda r: when(r) or 0, reverse=True):`,
    `  line = [r.${KEY_COL}, when(r), v(getattr(r, "${DELETE_COL}", False)), {c["id"]: g(r, c) for c in cols}]`,
    '  n = len(json.dumps(line, ensure_ascii=False))',
    // Une ligne plus grosse qu'un envoi ne partira jamais : signalée, pas renvoyée sans fin.
    `  if capped and n > max(budget, room):`,
    `    big.append(r.${KEY_COL})`,
    '    continue',
    // Le premier venu part même s'il dépasse le plafond du lot : seul, il tient dans un envoi.
    '  if capped and out and size + n > budget: break',
    '  size += n',
    `  if not capped and size > ${PUBLIC_MAX}: return json.dumps({"lignes": [], "total": len(rows), "trop": True})`,
    '  out.append(line)',
    'lot = {"lignes": out, "total": len(rows)}',
    'if big: lot["tropGros"] = big',
    `if capped and len(out) + len(big) < len(rows): lot.update(depuis=v(cut), renvoi=bool(again))`,
    'return json.dumps(lot, ensure_ascii=False)',
  ].join('\n');
}

// Sync_Etat (formule de déclenchement). Lignes 'suivi' : l'heure du dernier changement des clés
// (`t`), le plus grand numéro de ligne vu (`top`), la somme des CRC-32 des clés de chaque seau
// (`s`), et les clés des seaux qui en ont perdu une (`seaux`). Une ligne de numéro supérieur à
// `top` est nouvelle : un seau dont la somme a bougé d'autre chose que ses nouvelles clés a perdu
// une clé (ou changé une clé). Au-delà de PART_KEYS clés à envoyer, `trop` (l'heure) reste posé
// jusqu'à ce que le widget SOURCE ait renvoyé la liste complète (il recopie alors `trop` dans
// Synchro_Renvoi du suivi). Lignes 'lot' : la marque d'envoi coupé, la plus ancienne date d'un lot
// coupé, gardée jusqu'à ce que le widget envoie le reste (un lot de renvoi coupé ne compte pas : le
// widget le recoupe lui-même). Ligne 'echange' : l'heure de la dernière consolidation.
function stateFormula(pick) {
  return [
    'import json',
    `if $${TYPE_COL} == "${KIND.swap}": return NOW().timestamp()`,
    `if $${TYPE_COL} == "${KIND.lot}":`,
    `  lot = json.loads($${LOT_COL} or "{}")`,
    '  if lot.get("depuis") and not lot.get("renvoi"):',
    '    return min(value, lot["depuis"]) if value else lot["depuis"]',
    '  return value',
    `if $${TYPE_COL} != "${KIND.track}": return value`, pick, 'if src is None: return value', ...READ,
    'import zlib',
    'old = json.loads(value) if isinstance(value, str) and value.startswith("{") else {}',
    'top = old.get("top", 0)',
    `sums, fresh, keys = [0] * ${BUCKETS}, [0] * ${BUCKETS}, []`,
    'for r in src.all:',
    `  if not r.${KEY_COL} or not keep(r): continue`,
    `  k = str(r.${KEY_COL})`,
    '  h = zlib.crc32(k.encode())',
    `  b = h * ${BUCKETS} >> 32`,
    '  sums[b] = (sums[b] + h) & 0xffffffff',
    '  if r.id > top: fresh[b] = (fresh[b] + h) & 0xffffffff',
    '  keys.append((b, k))',
    'was = old.get("s")',
    'if was == sums: return value',
    't = v(NOW())',
    'state = {"t": t, "top": max([top] + [r.id for r in src.all]), "s": sums}',
    `if isinstance(was, list) and len(was) == ${BUCKETS}:`,
    `  moved = set(b for b in range(${BUCKETS}) if (was[b] + fresh[b]) & 0xffffffff != sums[b])`,
    '  left = {str(b): [] for b in moved}',
    '  for b, k in keys:',
    '    if b in moved: left[str(b)].append(k)',
    `  if sum(len(x) for x in left.values()) > ${PART_KEYS}: state["trop"] = str(t)`,
    '  elif left: state["seaux"] = {b: sorted(x) for b, x in left.items()}',
    `if old.get("trop") and old["trop"] != $${RESEND_COL} and "trop" not in state: state["trop"] = old["trop"]`,
    'return json.dumps(state)',
  ].join('\n');
}

// Colonnes de la table Synchro. Le journal de la CIBLE doit toutes les avoir (le webhook envoie
// chaque ligne entière) : une colonne ajoutée ici doit déjà exister dans les journaux.
export function syncColumns(tables) {
  const { keys, lot, state } = syncFormulas(tables);
  return [
    { id: EXPORT_COL, type: 'Text', isFormula: false },
    { id: TABLE_COL, type: 'Text', isFormula: false },
    { id: TYPE_COL, type: 'Text', isFormula: false },
    { id: SCHEMA_COL, type: 'Text', isFormula: false },
    { id: RESEND_COL, type: 'Text', isFormula: false },
    { id: LIST_COL, type: 'Text', isFormula: true, formula: keys },
    { id: LOT_COL, type: 'Text', isFormula: true, formula: lot },
    // Formule de déclenchement : ses dépendances (Synchro_Lot, Synchro_Ids, Synchro_Renvoi) sont posées après coup.
    { id: TRACK_COL, type: 'Any', isFormula: false, formula: state, recalcWhen: 0 },
    // E-mail de la personne qui crée l'export : présenté à la CIBLE comme propriétaire.
    { id: AUTHOR_COL, type: 'Text', isFormula: false, formula: 'user.Email', recalcWhen: 0 },
  ];
}

// ---------------------------------------------------------------------------------------------
// Colonnes ajoutées aux tables envoyées

// RecalculLe : heure (en secondes) du dernier recalcul de MajLe. Un nombre, et non une date : la
// formule du lot la lit sur toutes les lignes à chaque modification, et Grist lit une date environ
// cinq fois plus lentement (mesuré : 190 ms contre 38 ms sur 12 000 lignes).
export const RECALC_SPEC = { type: 'Numeric', isFormula: true, formula: `$${ORDER_COL}\nreturn NOW().timestamp()` };

// Colonnes de la synchro qui manquent à une table.
export const missingSyncColumns = cols => [KEY_COL, ORDER_COL, RECALC_COL].filter(id => !cols.some(c => c.colId === id));

// id_sync : UUID posé à la création. MajLe : NOW() à toute modification de la ligne.
export function prepareSourceActions(tableId, missing) {
  const specs = {
    [KEY_COL]: { type: 'Text', isFormula: false, formula: 'UUID()', recalcWhen: 0 },
    [ORDER_COL]: { type: 'DateTime:UTC', isFormula: false, formula: 'NOW()', recalcWhen: 2 },
    [RECALC_COL]: RECALC_SPEC,
  };
  return missing.map(colId => ['AddColumn', tableId, colId, specs[colId]]);
}

// Clé id_sync posée à la création d'une ligne (formule de déclenchement UUID()), sur une colonne
// qui existe déjà : celle d'une destination d'Échange, qui envoie aussi ses lignes nouvelles. Les
// lignes déjà là gardent leur clé.
export function keyTriggerAction(tableId, cols) {
  const key = cols.find(c => c.colId === KEY_COL);
  return key && !key.isFormula && key.formula !== 'UUID()' ? ['ModifyColumn', tableId, KEY_COL, { formula: 'UUID()', recalcWhen: 0 }] : null;
}

// Échange : la case Supprime efface une ligne des deux côtés ; elle est ajoutée aux tables qui
// n'en ont pas.
export const deleteColumnAction = (tableId, cols) =>
  (cols.some(c => c.colId === DELETE_COL) ? null : ['AddColumn', tableId, DELETE_COL, { type: 'Bool', isFormula: false }]);

// MajLe change quand une valeur envoyée change, et seulement alors : formule de déclenchement sur
// les colonnes envoyées par les exports (`colIds`), leurs colonnes d'affichage (texte d'une
// Référence) et Supprime. Une valeur qui change à cause d'une autre table (ville renommée, formule)
// la fait donc changer aussi (vérifié). Rend l'action qui la met à jour, ou null.
export function majleAction(cols, colIds) {
  const majle = cols.find(c => c.colId === ORDER_COL);
  if (!majle) return null;
  const sent = cols.filter(c => colIds.includes(c.colId) || c.colId === DELETE_COL);
  const refs = [...new Set(sent.flatMap(c => [c.id, c.displayCol]).filter(Boolean))].sort((a, b) => a - b);
  const deps = ['L', ...refs];
  const same = majle.recalcWhen === 0 && JSON.stringify(majle.recalcDeps || null) === JSON.stringify(deps);
  return same || !refs.length ? null : ['UpdateRecord', '_grist_Tables_column', majle.id, { recalcWhen: 0, recalcDeps: deps }];
}

// Une formule de déclenchement ajoutée après coup laisse les lignes existantes vides (vérifié).
export function fillKeyActions(tableId, rows, newId) {
  const empty = rows.filter(r => isBlank(r[KEY_COL])).map(r => r.id);
  return chunk(empty).map(ids => ['BulkUpdateRecord', tableId, ids, { [KEY_COL]: ids.map(() => newId()) }]);
}
