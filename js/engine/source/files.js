// SOURCE : envoi du contenu des pièces jointes, tant qu'un propriétaire a la page du widget ouverte
// (le rattrapage s'en charge, voir resend.js). Le webhook ne porte que la liste des fichiers de
// chaque cellule ; le widget envoie chaque fichier une fois par destinataire, en morceaux, à
// l'adresse de son webhook (le lien du formulaire de son journal). Ce qui est parti est noté dans
// la note de Synchro (`fichiers`, voir readTracking) : aucune table de plus.
import { EXPORT_COL, KIND, LOT_COL, SYNC_TABLE, TYPE_COL, groupBy, randomHex } from '../logic/common.js';
import { hooksOf, ownJournal } from '../logic/exports.js';
import { setFiles } from '../logic/notes.js';
import { encodeParts, fileSends, forgetHooks, holdFiles, mergeHeld, neededFiles, partRow, readTracking, recordSent, trackingNote } from '../logic/files.js';
import { downloadAttachment, fetchRows, postToHook, readSchema, selectRows } from '../port.js';
import { exportHooks, readSourceNote, syncRows, updateSourceNote } from './synchro.js';

const pending = new Map(); // export -> envois de fichiers restants, pour la carte
// Webhook dont un envoi direct a échoué (lien coupé, instance qui refuse) : il attend FAIL_HOLD_MS
// avant un nouvel essai, pour ne pas retélécharger le fichier à chaque rattrapage.
const failed = new Map();
const FAIL_HOLD_MS = 600000;

export const filesPending = exportId => pending.get(exportId) || 0;

// Lignes 'fichiers' de Synchro, avec leur liste (lue en SQL quand Grist le permet : les lots, de
// grosses cellules, ne sont pas relus).
async function fileRows() {
  const rows = await selectRows(SYNC_TABLE, [EXPORT_COL, TYPE_COL, LOT_COL], { [TYPE_COL]: KIND.files });
  return rows || (await fetchRows(SYNC_TABLE)).filter(r => r[TYPE_COL] === KIND.files);
}

const saveTracking = change => updateSourceNote(note => setFiles(note, change({ ...(note.fichiers || {}) })));
// Suivi d'export écrit en gardant ce que la CIBLE y a noté entre-temps (voir mergeHeld) ; `entries` :
// { export: suivi }. Avec `only`, les autres exports de la note restent tels quels ; sinon la note ne garde
// que ceux-là.
const saveTracked = (entries, only = true) => saveTracking(all => ({
  ...(only ? all : {}),
  ...Object.fromEntries(Object.entries(entries).map(([id, tracking]) => [id, trackingNote(mergeHeld(tracking, readTracking(all[id])))])),
}));

// Envois dus, par export qui envoie des fichiers : { exportId, needed, tracking, sends, hooks }.
// Le suivi nettoyé (fichiers retirés, destinataires partis) est écrit s'il a changé. `ok(h)` : le
// webhook reçoit (actif, sans échec).
export async function planFiles(hooks, conditions, ok) {
  const groups = groupBy(await fileRows(), r => r[EXPORT_COL]);
  const noted = readSourceNote(await readSchema()).fichiers || {};
  const recent = id => Date.now() - (failed.get(id) || 0) < FAIL_HOLD_MS;
  const plans = [...groups].map(([exportId, rows]) => {
    const mine = hooksOf(hooks, conditions, exportId);
    const active = mine.filter(h => ok(h) && !recent(h.id)).map(h => h.id);
    const needed = neededFiles(rows);
    return { exportId, needed, hooks: mine, ...fileSends(readTracking(noted[exportId]), needed, mine.map(h => h.id), active) };
  });
  pending.clear();
  for (const p of plans) pending.set(p.exportId, p.sends.reduce((n, s) => n + s.hooks.length, 0));
  const next = Object.fromEntries(plans.map(p => [p.exportId, trackingNote(p.tracking)]));
  if (JSON.stringify(next) !== JSON.stringify(noted)) await saveTracked(Object.fromEntries(plans.map(p => [p.exportId, p.tracking])), false);
  return plans.filter(p => p.sends.length);
}

// Envoie les fichiers dus, un à la fois : téléchargé une fois, puis, pour chaque destinataire, tous
// ses morceaux à la suite ; il est noté reçu quand le dernier morceau est accepté. Un webhook dont le
// partenaire a déjà le fichier (`held`, Échange) n'en reçoit rien et est noté l'avoir. Les envois
// suivent le budget des renvois (`spend`, qui attend s'il est dépassé ; `spend(0)` attend seulement) :
// les modifications ordinaires, elles, partent toujours. Rend le nombre d'envois faits.
export async function sendFiles(plans, spend) {
  let done = 0;
  for (const plan of plans) {
    let { tracking } = plan;
    for (const { sha, hooks: ids, held = [] } of plan.sends) {
      const sent = ids.length ? await sendFile(plan, sha, ids, spend) : [];
      tracking = recordSent(tracking, sha, [...sent, ...held]);
      await saveTracked({ [plan.exportId]: tracking });
      pending.set(plan.exportId, Math.max(0, filesPending(plan.exportId) - ids.length));
      done += sent.length;
    }
  }
  return done;
}

// Un fichier, téléchargé une fois, envoyé en entier à chaque webhook de `ids` ; rend ceux qui l'ont
// reçu. Un webhook en échec attend (voir failed).
async function sendFile(plan, sha, ids, spend) {
  await spend(0);
  const file = plan.needed.get(sha);
  const bytes = await downloadAttachment(file.id);
  const parts = encodeParts(bytes);
  const info = { sha, name: file.name, size: bytes.length };
  const send = randomHex(4);
  const rows = parts.map((part, n) => partRow(plan.exportId, info, send, n, parts.length, part));
  const size = parts.reduce((total, part) => total + part.length, 0);
  const sent = [];
  for (const h of plan.hooks.filter(x => ids.includes(x.id))) {
    try {
      for (const row of rows) await postToHook(h, [row]);
      sent.push(h.id);
    } catch (e) {
      failed.set(h.id, Date.now());
    }
    await spend(size);
  }
  return sent;
}

// « Tout renvoyer » : les destinataires de l'export reçoivent de nouveau tous ses fichiers.
export async function resendFiles(exportId) {
  const noted = readSourceNote(await readSchema()).fichiers || {};
  if (!noted[exportId]) return;
  await saveTracked({ [exportId]: forgetHooks(readTracking(noted[exportId])) });
}

// Échange : les fichiers que les versions signées reçues dans le journal `journal` citent (`cited`,
// empreintes abrégées, voir citedFiles) sont chez le partenaire qui les a envoyés : ils sont notés
// pour son ou ses webhooks, et ne lui seront pas renvoyés (voir holdFiles). Fait avant le dépôt, pour
// qu'aucun envoi ne parte entre l'arrivée d'un fichier et le remplissage de sa cellule. Rien n'est
// écrit pour un export qui n'envoie pas de fichiers. Les empreintes déjà notées par cette page ne
// sont pas relues. Un refus d'écrire la note (document en lecture seule, droits) est sans suite :
// le prochain passage d'un propriétaire la complète.
const noted = new Map(); // journal -> empreintes déjà notées par cette page

export async function noteHeldFiles(journal, note, cited) {
  const have = noted.get(journal) || new Set();
  const fresh = [...cited].filter(k => !have.has(k));
  if (!fresh.length || note.mode !== 'echange') return;
  try {
    if (!(await syncRows()).some(r => r[EXPORT_COL] === note.export && r[TYPE_COL] === KIND.files)) return;
    const hooks = note.retour && note.hook ? [{ id: note.hook }] : (await exportHooks(note.export)).filter(h => !note.retour || ownJournal(h)({ note }));
    if (!hooks.length) return;
    const ids = hooks.map(h => h.id);
    const held = tracking => trackingNote(holdFiles(tracking, ids, fresh));
    const was = readTracking((readSourceNote(await readSchema()).fichiers || {})[note.export]);
    if (JSON.stringify(held(was)) !== JSON.stringify(trackingNote(was))) {
      await saveTracking(all => ({ ...all, [note.export]: held(readTracking(all[note.export])) }));
    }
    noted.set(journal, new Set([...have, ...fresh]));
  } catch (e) {
    // Sans suite : un envoi de trop au pire, jamais un fichier perdu.
  }
}
