// CIBLE : réception des pièces jointes. Les morceaux d'un fichier arrivent dans le journal (lignes
// 'fichier', envoyées par le widget SOURCE, voir logic/files.js). Arrivé en entier et vérifié
// (taille, SHA-1), le fichier est déposé dans le document avec les droits de la personne, sauf s'il
// y est déjà, puis ses morceaux sont effacés. Les cellules qui le citent sont remplies par la
// recopie (voir loop.js).
import { apply, fetchRows, uploadAttachment } from '../port.js';
import { chunk, nowS } from '../logic/common.js';
import { fileArrivals, joinParts, parkedOverflow, sha1, shaOf, short } from '../logic/files.js';

// Dépôt refusé par Grist (taille maximale de l'instance, droits) : ses morceaux restent, et il
// n'est retenté qu'au bout de RETRY_MS. Gardé ici pour la carte : journal -> Map(empreinte ->
// { name, error, at }).
const RETRY_MS = 600000;
const refused = new Map();
export const uploadErrors = journal => [...(refused.get(journal) || new Map()).values()];

// Fichiers du document : empreinte -> numéro dans _grist_Attachments.
export async function attachments() {
  const present = new Map();
  for (const attachment of await fetchRows('_grist_Attachments')) {
    const sha = shaOf(attachment.fileIdent);
    if (sha && !present.has(sha)) present.set(sha, attachment.id);
  }
  return present;
}

// Reçoit les fichiers arrivés en entier dans le journal `journal` (lignes `rows`) ; `files()` rend
// les fichiers du document (voir attachments), complétés au fil des dépôts. Un fichier qu'aucune
// version ne cite (`cited`, voir citedFiles) attend la sienne, un jour au plus (il peut arriver
// avant elle), puis est effacé. Quand toutes les versions arrivées sont dépliées (`settled`), les
// morceaux en attente au-delà de PARKED_MAX sont effacés, les plus anciens d'abord. Rend les
// lignes qui restent dans le journal et le nombre de lignes ou de fichiers rejetés (illisibles,
// altérés, envois incomplets en trop).
export async function receiveFiles(journal, exportId, rows, files, cited, settled = true) {
  const { ready, stale, rejected, partial } = fileArrivals(rows, exportId, nowS());
  if (!ready.length && !stale.length && !rejected.length && !partial.length) return { rows, rejected: 0 };
  const errors = refused.get(journal) || new Map();
  refused.set(journal, errors);
  const done = [...stale, ...rejected];
  let bad = rejected.length;
  const present = await files();
  const parked = [...partial];
  for (const file of ready) {
    const outcome = await receiveFile(file, { present, cited, errors });
    if (outcome === 'park') parked.push(file);
    else if (outcome !== 'wait') done.push(...file.ids);
    if (outcome === 'bad') bad++;
  }
  if (settled) {
    // Seuls les envois incomplets en trop sont suspects : des fichiers entiers peuvent venir d'une
    // table refusée ici.
    const over = parkedOverflow(parked);
    bad += over.filter(g => !g.sha).length;
    done.push(...over.flatMap(g => g.ids));
  }
  await apply(chunk(done).map(part => ['BulkRemoveRecord', journal, part]));
  const gone = new Set(done);
  return { rows: rows.filter(r => !gone.has(r.id)), rejected: bad };
}

// Sort d'un fichier arrivé en entier (ses morceaux sont effacés sauf pour 'park' et 'wait') :
// déjà là ou déposé ('done'), altéré ('bad'), cité par aucune version ('park' ; 'done' au bout
// d'un jour), dépôt à retenter plus tard ('wait').
async function receiveFile(file, { present, cited, errors }) {
  if (present.has(file.sha)) return 'done';
  if (!cited.has(short(file.sha))) return file.old ? 'done' : 'park';
  if (Date.now() - (errors.get(file.sha)?.at || 0) < RETRY_MS) return 'wait';
  const bytes = joinParts(file.data);
  if (bytes.length !== file.size || await sha1(bytes) !== file.sha) return 'bad';
  try {
    present.set(file.sha, await uploadAttachment(file.name, bytes));
    errors.delete(file.sha);
    return 'done';
  } catch (e) {
    errors.set(file.sha, { name: file.name, error: e.message, at: Date.now() });
    return 'wait';
  }
}
