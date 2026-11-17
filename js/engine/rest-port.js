// Les requêtes REST du moteur, écrites une seule fois : webhooks (création avec condition relue dans
// _grist_Triggers, file vidée avant l'effacement, avis de fin), comparaison d'états, lecture SQL, envoi
// direct de lignes, lecture publique, fiche d'un partage, pièces jointes. Un hôte (syncPlus, GFS) donne
// `http`, tout ce qui touche vraiment le réseau et le jeton, et en tire ces fonctions du port :
//
//   const rest = createRestPort({ docApi: { fetchRows }, http });
//   const port = { ...ses fonctions de lecture et d'écriture, ...rest, withLock, text, page, prefs };
//
// `docApi.fetchRows(tableId)` : les lignes d'une table du document (celles de _grist_Triggers sont lues
// pour les conditions des webhooks).
//
// `http` (fourni par l'hôte, qui ajoute le jeton et décide d'où l'on peut écrire) :
//  - `request(méthode, chemin, { body, params, full, timeout })` : REST du document courant, `chemin`
//    relatif à son adresse (`/webhooks`, `/sql`, `/compare`…), `params` en paramètres d'adresse (texte),
//    `body` objet envoyé en JSON, `full` : avec les droits de la personne (sinon en lecture seule),
//    `timeout` en ms. Rend `{ status, body }` (`body` : le JSON lu, null si la réponse est vide). **Lève**
//    une erreur portant `status` (nombre) et `message` (le début du texte de la réponse, 200 caractères au
//    plus) sur tout refus (statut hors 2xx) ; une erreur sans `status` quand le réseau reste muet.
//  - `anonymous(méthode, adresse, { body, timeout })` : requête sans jeton à une adresse complète
//    (clé de formulaire, document public, fiche d'un partage). L'hôte ne l'autorise que vers le serveur du
//    document. Rend et lève comme `request`.
//  - `download(numéro)` : les octets (Uint8Array) de la pièce jointe `numéro` du document ; lève comme `request`.
//  - `upload(nom, octets)` : dépose un fichier, avec les droits de la personne ; rend son numéro ; lève comme
//    `request`.
//  - `docBaseUrl()` : l'adresse REST du document courant (`https://hôte[/o/équipe]/api/docs/<id>`), ou une
//    promesse qui la rend.
//
// Rien ici ne lit `document`, `window` ni `grist` : un hôte qui parle autrement à Grist (un cadre sans
// origine, par exemple) ne refait que `http`.
import { maskKey, parseWebhookUrl } from './logic/codes.js';
import { parseJson } from './logic/common.js';
import { readShare } from './logic/trust.js';

// Délais d'abandon : avis de fin envoyé juste avant d'effacer un webhook, fiche d'un partage, envoi direct
// de lignes (morceau de fichier, test du lien).
const SHORT_MS = 10000;
const SHARE_MS = 15000;
const POST_MS = 60000;

// Un refus de l'hôte (erreur portant un statut) devient une réponse `{ status }` ; un réseau muet (erreur sans
// statut) remonte.
const answer = async (promise) => {
  try {
    return await promise;
  } catch (e) {
    if (typeof e?.status === 'number') return { status: e.status, body: null, message: e.message };
    throw e;
  }
};

// Grist refuse aussi par 403 un webhook dont l'adresse n'est pas dans la liste des domaines autorisés de l'instance
// (réglage ALLOWED_WEBHOOK_DOMAINS, « Provided url is forbidden », vérifié sur Grist 1.7) : ce refus-là n'est pas une
// question de droits, et seul l'administrateur de l'instance le lève.
const URL_REFUSED = /url is forbidden/i;

// Une requête REST du document avec les droits de la personne ; le corps rendu, ou 'ownerOnly' (403 : seul un
// propriétaire lit les webhooks), 'webhookForbidden' (403 : adresse de webhook que l'instance n'autorise pas) ou une
// erreur qui cite le début de la réponse. Une erreur de Grist peut citer l'adresse d'un webhook : sa clé n'est jamais
// montrée en entier.
const restOf = http => async (method, path, body) => {
  const response = await answer(http.request(method, path, { body, full: true }));
  if (response.status === 403) throw new Error(URL_REFUSED.test(response.message || '') ? 'webhookForbidden' : 'ownerOnly');
  if (response.status >= 300) throw new Error(maskKey(`HTTP ${response.status} ${String(response.message || '').slice(0, 200)}`));
  return response.body;
};

// Chaque groupe de requêtes est une fonction du module qui reçoit ce qu'il lui faut (`http`, `rest`, `docApi`) et rend sa
// part du port ; `createRestPort`, en bas, ne fait qu'assembler. L'état qu'un groupe retient pour la session (le droit de
// propriétaire, l'origine du document) reste dans sa fermeture : un port créé a le sien.

// Lectures SQL du document, avec les droits de la personne.
function sqlPort(http) {
  // Une requête SQL de lecture sur le document, avec les droits de la personne (Grist la réserve à qui peut
  // lire tout le document) ; rend les lignes, ou null si Grist refuse (droits, table absente, requête invalide).
  async function querySql(query) {
    try {
      const response = await answer(http.request('GET', '/sql', { params: { q: query }, full: true }));
      return response.status >= 300 ? null : response.body.records.map(r => r.fields);
    } catch (e) {
      return null;
    }
  }

  // Quelques colonnes d'une table, lues en SQL : bien plus léger que fetchTable quand la table a de grosses
  // cellules (lots de Synchro), pour une lecture répétée. `where` : { colonne: valeur } (des noms du widget,
  // pas des valeurs lues ailleurs). Null si Grist refuse (droits, table absente) : lire alors la table entière.
  async function selectRows(tableId, colIds, where = {}) {
    const test = Object.entries(where).map(([c, v]) => `"${c}" = '${String(v).replace(/'/g, "''")}'`).join(' and ');
    return querySql(`select ${['id', ...colIds].map(c => `"${c}"`).join(', ')} from "${tableId}"${test ? ` where ${test}` : ''}`);
  }

  // Résumé d'un journal en une seule requête : { n, last, raw } = lignes, dernière arrivée (secondes) et lignes
  // brutes pas encore dépliées. Null si Grist refuse (droits) ou si le journal n'a pas ces colonnes (journal
  // d'avant la 0.5).
  async function journalStats(tableId, receivedCol, typeCol) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableId)) return null;
    const [row] = (await querySql(`select count(*) as n, max("${receivedCol}") as last, sum(case when "${typeCol}" is not null and "${typeCol}" != '' then 1 else 0 end) as raw from "${tableId}"`)) || [];
    return row ? { n: Number(row.n) || 0, last: Number(row.last) || 0, raw: Number(row.raw) || 0 } : null;
  }

  return { querySql, selectRows, journalStats };
}

// Comparaison de deux états du document.
function changesPort(http) {
  // Ce qui a changé dans le document depuis l'état `since` (empreinte d'une action de son historique) :
  // l'état actuel (`hash`) et les tables touchées, lignes ou colonnes (`tables` ; null = inconnu, tout relire :
  // si `since` est vide ou sorti de l'historique, si une table a été renommée, ou si Grist n'a pas pu répondre).
  // Lu par la comparaison de deux états de Grist (GET /compare, quelques millisecondes ; une valeur au plus par
  // colonne revient). Null si Grist refuse : la comparaison est réservée à qui peut lire tout le document.
  async function docChanges(since) {
    const read = left => answer(http.request('GET', '/compare', { params: { left, right: 'HEAD', maxRows: 1 }, full: true }));
    try {
      let response = await read(since || 'HEAD');
      if ([401, 403].includes(response.status)) return null;
      // Un état que Grist ne connaît plus (500 « Cannot read hash » sur la 1.7.19) : on repart de HEAD, mais les
      // changements arrivés pendant que l'état était perdu ne se savent plus. La réponse de HEAD contre HEAD n'a
      // aucun changement : elle ne doit pas passer pour « rien n'a changé » (`tables` null).
      let lost = !since;
      if (response.status >= 300 && since) {
        lost = true;
        response = await read('HEAD');
      }
      if (response.status >= 300) return response.status === 404 ? null : { hash: since, tables: null };
      const { right, details } = response.body;
      const delta = (details || {}).rightChanges;
      const known = !lost && delta && !(delta.tableRenames || []).length;
      return { hash: right.h, tables: known ? new Set(Object.keys(delta.tableDeltas || {})) : null };
    } catch (e) {
      return { hash: since, tables: null };
    }
  }

  return { docChanges };
}

// Webhooks, lectures (propriétaires du document seulement : Grist refuse sinon en 403).
function webhookListPort({ rest, docApi }) {
  let owner = null;
  const listWebhooks = async () => (await rest('GET', '/webhooks')).webhooks;

  // Propriétaire du document : seul un propriétaire lit la liste des webhooks. Une réponse sûre est gardée pour
  // la session ; une autre erreur (réseau, document rechargé) remonte, sans rien garder.
  async function isOwner() {
    if (owner === null) {
      try {
        await listWebhooks();
        owner = true;
      } catch (e) {
        if (e.message !== 'ownerOnly') throw e;
        owner = false;
      }
    }
    return owner;
  }

  // Condition de chaque webhook du document (texte de la formule), par identifiant de webhook : lue dans
  // _grist_Triggers, où Grist garde aussi l'identifiant de chaque webhook.
  async function webhookConditions() {
    const conditions = new Map();
    for (const trigger of await docApi.fetchRows('_grist_Triggers')) {
      const text = (parseJson(trigger.condition || '{}') || {}).text || '';
      const actions = parseJson(trigger.actions || '[]');
      for (const action of Array.isArray(actions) ? actions : []) if (action && action.type === 'webhook') conditions.set(action.id, text);
    }
    return conditions;
  }

  return { listWebhooks, isOwner, webhookConditions };
}

// Envoi direct de lignes à une adresse d'écriture.
function directPort(http) {
  let ownOrigin = '';

  // Envoi direct de lignes à une adresse d'écriture (clé d'un formulaire publié : elle n'accepte qu'un ajout de
  // lignes, sans identifiant), comme le webhook les enverrait. Une erreur cite le début de la réponse, jamais la
  // clé. Seulement vers l'instance du document, comme le webhook : une adresse d'une autre instance (lien collé,
  // webhook changé à la main) est refusée avant tout envoi.
  async function postRows(url, rows, timeout = POST_MS) {
    ownOrigin ||= new URL(await http.docBaseUrl()).origin;
    if (new URL(url).origin !== ownOrigin) throw new Error('otherInstance');
    const response = await answer(http.anonymous('POST', url, { body: rows, timeout }));
    if (response.status >= 300) throw new Error(maskKey(`HTTP ${response.status} ${String(response.message || '').slice(0, 120)}`));
  }
  const postToHook = (h, rows, timeout) => postRows(h.fields.url, rows, timeout);

  return { postRows, postToHook };
}

// Webhooks, écritures : création avec sa condition relue, réglages, effacement (file vidée d'abord, avis de fin).
function webhookEditPort({ rest, webhookConditions, postToHook }) {
  // Effacer un webhook ne coupe pas l'envoi que Grist retente pour lui (20 essais espacés jusqu'à 64 s, un quart
  // d'heure) : cet envoi garde la file de tout le document et les autres destinataires attendent derrière (vu au
  // test de charge : plus de deux minutes après la révocation). Vider d'abord la file de ce webhook seul abandonne
  // l'envoi en cours. Les Grist qui n'ont pas cette route l'ignorent.
  const clearHookQueue = id => rest('DELETE', `/webhooks/queue/${encodeURIComponent(id)}`);
  async function deleteWebhook(id) {
    await clearHookQueue(id).catch(() => {});
    return rest('DELETE', `/webhooks/${encodeURIComponent(id)}`);
  }

  // Un webhook par destinataire, sur la table Synchro, filtré par `condition` (formule évaluée par Grist sur
  // chaque ligne : seules celles de l'export partent). Grist accepte les conditions depuis la version 1.7.11 :
  // une instance plus ancienne refuse le champ, ou l'ignore ; on vérifie donc la condition enregistrée et on
  // efface le webhook si elle manque (il recevrait tout). Rend l'identifiant du webhook.
  async function createWebhook({ name, memo, url, tableId, condition }) {
    let result;
    try {
      result = await rest('POST', '/webhooks', {
        webhooks: [{ fields: { name, memo, url, tableId, condition, eventTypes: ['add', 'update'], enabled: true, isReadyColumn: null } }],
      });
    } catch (e) {
      if (/condition/i.test(e.message)) throw new Error('gristTooOld');
      throw e;
    }
    const id = result.webhooks[0].id;
    if ((await webhookConditions()).get(id) !== condition) {
      await deleteWebhook(id).catch(() => {});
      throw new Error('gristTooOld');
    }
    return id;
  }

  // Webhook effacé après un dernier envoi direct à son adresse. Un lien déjà mort ou trop lent ne retient pas
  // l'effacement.
  async function deleteWebhookWithNotice(h, rows) {
    await postToHook(h, rows, SHORT_MS).catch(() => {});
    await deleteWebhook(h.id);
  }

  return {
    createWebhook,
    setWebhookEnabled: (id, enabled) => rest('PATCH', `/webhooks/${encodeURIComponent(id)}`, { enabled }),
    renameWebhook: (id, name, memo) => rest('PATCH', `/webhooks/${encodeURIComponent(id)}`, memo === undefined ? { name } : { name, memo }),
    deleteWebhook,
    deleteWebhookWithNotice,
    clearWebhookQueue: () => rest('DELETE', '/webhooks/queue'),
  };
}

// Partage d'un formulaire et lecture d'un document public : requêtes sans jeton.
function sharePort(http) {
  // Document que désigne l'adresse d'écriture `url` (clé d'un formulaire publié), lu chez Grist par une requête
  // anonyme : nom, dossier, équipe, identifiant (voir readShare). Null si la clé n'existe pas (lien coupé) ; une
  // erreur si Grist ne répond pas.
  async function shareInfo(url) {
    const target = parseWebhookUrl(url);
    if (!target) return null;
    const response = await answer(http.anonymous('GET', `${target.origin}${target.prefix}/api/s/${target.key}`, { timeout: SHARE_MS }));
    if (response.status === 404 || response.status === 403) return null;
    if (response.status >= 300) throw new Error('shareUnreadable');
    const info = readShare(response.body);
    if (!info) throw new Error('shareUnreadable');
    return info;
  }

  // Droit du lien public du document d'adresse REST `base` : 'viewers', 'editors' (s'il a été réglé sur Éditeur),
  // '' s'il n'est pas public, ou null quand la réponse ne permet pas de le dire (réseau, serveur occupé).
  async function publicAccess(base) {
    try {
      const response = await answer(http.anonymous('GET', base, {}));
      if (response.status < 300) return String((response.body || {}).access || 'viewers');
      return [401, 403, 404].includes(response.status) ? '' : null;
    } catch (e) {
      return null;
    }
  }

  // Lignes d'une table d'un document public (`filter` : { colonne: [valeurs] }). Une erreur 'publicClosed' si
  // Grist refuse ou ne répond pas.
  async function publicRecords(base, tableId, filter) {
    const query = encodeURIComponent(JSON.stringify(filter));
    const response = await answer(http.anonymous('GET', `${base}/tables/${tableId}/records?filter=${query}`, {})).catch(() => null);
    if (!response || response.status >= 300) throw new Error('publicClosed');
    return (response.body || {}).records || [];
  }

  return { shareInfo, publicAccess, publicRecords };
}

// Pièces jointes du document.
function attachmentPort(http) {
  // Contenu d'une pièce jointe du document (numéro dans _grist_Attachments).
  async function downloadAttachment(id) {
    try {
      return await http.download(Number(id));
    } catch (e) {
      throw new Error(typeof e?.status === 'number' ? `HTTP ${e.status}` : e.message);
    }
  }

  // Dépose un fichier dans le document, avec les droits de la personne ; rend son numéro.
  async function uploadAttachment(name, bytes) {
    try {
      return await http.upload(name, bytes);
    } catch (e) {
      throw new Error(typeof e?.status === 'number' ? `HTTP ${e.status} ${String(e.message || '').slice(0, 200)}` : e.message);
    }
  }

  return { downloadAttachment, uploadAttachment };
}

export function createRestPort({ docApi, http }) {
  const rest = restOf(http);
  const { querySql, selectRows, journalStats } = sqlPort(http);
  const { docChanges } = changesPort(http);
  const { listWebhooks, isOwner, webhookConditions } = webhookListPort({ rest, docApi });
  const { postRows, postToHook } = directPort(http);
  const { createWebhook, setWebhookEnabled, renameWebhook, deleteWebhook, deleteWebhookWithNotice, clearWebhookQueue } = webhookEditPort({ rest, webhookConditions, postToHook });
  const { shareInfo, publicAccess, publicRecords } = sharePort(http);
  const { downloadAttachment, uploadAttachment } = attachmentPort(http);

  return {
    querySql,
    selectRows,
    journalStats,
    docChanges,
    isOwner,
    downloadAttachment,
    uploadAttachment,
    listWebhooks,
    createWebhook,
    webhookConditions,
    setWebhookEnabled,
    renameWebhook,
    deleteWebhook,
    deleteWebhookWithNotice,
    clearWebhookQueue,
    postRows,
    postToHook,
    publicRecords,
    publicAccess,
    shareInfo,
  };
}
