// Accès au document courant, avec les droits de la personne qui a ouvert la page.
// Deux canaux seulement :
//  - l'API des widgets (`grist.docApi`) : lecture des tables, écritures groupées ;
//  - l'API REST de la même instance pour les webhooks, que l'API des widgets n'expose pas, et
//    pour des lectures légères en SQL, avec un jeton d'accès court (`getAccessToken`) passé en
//    paramètre `auth=`.
// Toute requête réseau du widget passe par gristFetch.
import { GRIST_ORIGINS } from './config.js';
import { maskKey, parseDocBaseUrl } from './logic/codes.js';
import { toRows } from './logic/common.js';

// Requête vers une instance Grist de la liste (config.js), jamais ailleurs, sans les cookies de
// la personne (le jeton, quand il en faut un, est dans l'adresse).
export async function gristFetch(url, options = {}) {
  if (!GRIST_ORIGINS.includes(new URL(url).origin)) throw new Error('otherInstance');
  return fetch(url, { ...options, credentials: 'omit' });
}

export const fetchRows = async tableId => toRows(await grist.docApi.fetchTable(tableId));

export const apply = actions => (actions.length ? grist.docApi.applyUserActions(actions) : null);

// Instantané des métadonnées du document (tables et colonnes), lu en deux requêtes, et relu après
// une écriture qui change le schéma. Les tables de résumé et les tables cachées de Grist ne sont
// pas listées, mais `has` et `columns` les connaissent.
export async function readSchema() {
  const [tables, columns] = await Promise.all([fetchRows('_grist_Tables'), fetchRows('_grist_Tables_column')]);
  const byId = new Map(tables.map(tb => [tb.tableId, tb]));
  const colById = new Map(columns.map(c => [c.id, c]));
  return {
    tableIds: tables.filter(tb => !tb.summarySourceTable && !tb.tableId.startsWith('GristHidden')).map(tb => tb.tableId).sort(),
    has: tableId => byId.has(tableId),
    table: tableId => byId.get(tableId),
    // Nom exact d'une table nommée `tableId` aux majuscules près (Grist ne les distingue pas), ou null.
    resolve: tableId => (tables.find(tb => tb.tableId.toLowerCase() === String(tableId).toLowerCase()) || {}).tableId || null,
    // Nom actuel de la table de numéro `ref` (il change si on la renomme), ou null.
    tableIdOf: ref => (tables.find(tb => tb.id === ref) || {}).tableId || null,
    // Colonnes d'une table, dans l'ordre de leur création ; null si la table n'existe pas.
    // `visible` : colonne affichée d'une Référence, dans la table visée.
    columns(tableId) {
      const table = byId.get(tableId);
      if (!table) return null;
      return columns.filter(c => c.parentId === table.id).sort((x, y) => x.parentPos - y.parentPos).map(c => ({
        id: c.id, colId: c.colId, type: c.type, isFormula: c.isFormula, formula: c.formula, label: c.label, description: c.description,
        displayCol: c.displayCol, recalcWhen: c.recalcWhen, recalcDeps: c.recalcDeps,
        visible: (colById.get(c.visibleCol) || {}).colId || '',
      }));
    },
  };
}

// Identité du document, déduite de l'adresse REST du jeton : instance, équipe, identifiant, et
// l'adresse elle-même (`baseUrl`).
export async function docIdentity() {
  const { baseUrl } = await grist.docApi.getAccessToken({ readOnly: true });
  return { ...parseDocBaseUrl(baseUrl), baseUrl };
}

// La personne ne fait que lire le document : Grist le dit dans l'adresse du widget (`readonly`).
// Le nom du document, lui, n'est pas lisible : l'API REST refuse au jeton la fiche du document.
export const isReadOnly = () => new URLSearchParams(location.search).get('readonly') === 'true';

// Propriétaire du document : seul un propriétaire lit la liste des webhooks.
export const isOwner = () => listWebhooks().then(() => true, () => false);

// Quelques colonnes d'une table, lues par l'API REST en SQL (jeton en lecture seule) : bien plus
// léger que fetchTable quand la table a de grosses cellules (lots de Synchro), pour une lecture
// répétée. Null si Grist refuse (droits, table absente) : lire alors la table entière.
export async function selectRows(tableId, colIds) {
  try {
    const { token, baseUrl } = await grist.docApi.getAccessToken({ readOnly: true });
    const sql = `select ${['id', ...colIds].map(c => `"${c}"`).join(', ')} from "${tableId}"`;
    const response = await gristFetch(`${baseUrl}/sql?q=${encodeURIComponent(sql)}&auth=${encodeURIComponent(token)}`);
    return response.ok ? (await response.json()).records.map(r => r.fields) : null;
  } catch (e) {
    return null;
  }
}

// Une seule exécution à la fois de `fn` sous ce nom, tous onglets du navigateur confondus.
export const withLock = (name, fn) => (navigator.locks ? navigator.locks.request(name, fn) : fn());

// ---------------------------------------------------------------------------------------------
// Webhooks (propriétaires du document seulement : Grist refuse sinon en 403)

async function rest(method, path, body) {
  const { token, baseUrl } = await grist.docApi.getAccessToken({ readOnly: false });
  const response = await gristFetch(`${baseUrl}${path}${path.includes('?') ? '&' : '?'}auth=${encodeURIComponent(token)}`, {
    method,
    // Grist exige l'un de ces en-têtes pour toute écriture sans cookie (protection CSRF).
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    // Une erreur de Grist peut citer l'adresse d'un webhook : sa clé n'est jamais montrée en entier.
    const error = new Error(response.status === 403 ? 'ownerOnly' : maskKey(`HTTP ${response.status} ${text.slice(0, 200)}`));
    error.status = response.status;
    throw error;
  }
  return text ? JSON.parse(text) : null;
}

export const listWebhooks = async () => (await rest('GET', '/webhooks')).webhooks;

// Un webhook par destinataire, sur la table Synchro, filtré par `condition` (formule évaluée par
// Grist sur chaque ligne : seules celles de l'export partent). Grist accepte les conditions depuis
// la version 1.7.11 : une instance plus ancienne refuse le champ, ou l'ignore ; le widget vérifie
// donc la condition enregistrée et efface le webhook si elle manque (il recevrait tout).
export async function createWebhook({ name, memo, url, tableId, condition }) {
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

// Condition de chaque webhook du document (texte de la formule), par identifiant de webhook :
// lue dans _grist_Triggers, où Grist garde aussi l'identifiant de chaque webhook.
export async function webhookConditions() {
  const conditions = new Map();
  for (const trigger of await fetchRows('_grist_Triggers')) {
    let text = '';
    try { text = (JSON.parse(trigger.condition || '{}') || {}).text || ''; } catch (e) { /* condition illisible */ }
    let actions = [];
    try { actions = JSON.parse(trigger.actions || '[]') || []; } catch (e) { /* actions illisibles */ }
    for (const action of actions) if (action && action.type === 'webhook') conditions.set(action.id, text);
  }
  return conditions;
}

export const setWebhookEnabled = (id, enabled) => rest('PATCH', `/webhooks/${encodeURIComponent(id)}`, { enabled });
export const renameWebhook = (id, name) => rest('PATCH', `/webhooks/${encodeURIComponent(id)}`, { name });
export const deleteWebhook = id => rest('DELETE', `/webhooks/${encodeURIComponent(id)}`);
export const clearWebhookQueue = () => rest('DELETE', '/webhooks/queue');
