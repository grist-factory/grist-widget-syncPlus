// Le seul branchement du moteur vers l'extérieur. Le moteur ne parle jamais à Grist, au navigateur ni
// à la langue de la personne autrement que par l'objet `port` qu'on lui donne au démarrage
// (startEngine, index.js). syncPlus seul le remplit avec `js/sync-port.js` ; une autre page (GFS) donne
// le sien. Les modules du moteur importent d'ici les mêmes noms que ceux de l'ancien `js/grist.js` :
// chaque appel est rendu au port courant, au moment de l'appel (rien n'est lu à l'import).
//
// Contrat (PORT_SHAPE) :
//  - les fonctions de Grist, avec les droits de la personne qui a ouvert la page ;
//  - `withLock(nom, fn)` : une seule exécution à la fois de `fn` sous ce nom, toutes pages du
//    navigateur confondues (sans verrou possible : appeler `fn`) ;
//  - `text(clé, valeurs)` : le texte de la clé dans la langue de la personne (la clé elle-même si
//    elle est inconnue : `errors.js` s'en sert pour reconnaître une erreur prévue) ;
//  - `page` : la page est-elle visible (`visible`), quelque chose l'attend-il (`busy` : un assistant
//    est ouvert, un changement de règles d'accès le fermerait), et ses deux événements, `onShow`
//    (elle redevient visible) et `onLeave` (elle va se fermer) ;
//  - `prefs` : de quoi retenir deux petites valeurs par navigateur (la date de la dernière visite
//    d'un document, l'identifiant du navigateur), sans aucune donnée des tables.

export const PORT_SHAPE = {
  // Données du document : lire, écrire, schéma, identité, droits.
  data: ['fetchRows', 'apply', 'readSchema', 'selectRows', 'querySql', 'journalStats', 'docIdentity', 'isOwner', 'docChanges'],
  // Pièces jointes du document.
  files: ['downloadAttachment', 'uploadAttachment'],
  // Webhooks du document (propriétaires seulement) et envois directs à leur adresse.
  hooks: ['listWebhooks', 'createWebhook', 'webhookConditions', 'setWebhookEnabled', 'renameWebhook', 'deleteWebhook',
    'deleteWebhookWithNotice', 'clearWebhookQueue', 'postToHook', 'postRows'],
  // Un document public, lu sans identifiant ; et le document que désigne la clé d'un formulaire (anonyme).
  publicDoc: ['publicRecords', 'publicAccess', 'shareInfo'],
  // Ce qui vient de la page.
  environment: ['withLock', 'text'],
  page: ['visible', 'busy', 'onShow', 'onLeave'],
  prefs: ['read', 'write'],
};

let port = null;

// Branche le port. Refuse un port incomplet : mieux vaut une erreur au démarrage qu'un
// « x is not a function » en plein envoi.
export function setPort(next) {
  const missing = [];
  for (const name of [...PORT_SHAPE.data, ...PORT_SHAPE.files, ...PORT_SHAPE.hooks, ...PORT_SHAPE.publicDoc, ...PORT_SHAPE.environment]) {
    if (!next || typeof next[name] !== 'function') missing.push(name);
  }
  for (const name of PORT_SHAPE.page) if (!next || !next.page || typeof next.page[name] !== 'function') missing.push(`page.${name}`);
  for (const name of PORT_SHAPE.prefs) if (!next || !next.prefs || typeof next.prefs[name] !== 'function') missing.push(`prefs.${name}`);
  if (missing.length) throw new Error(`port incomplet : ${missing.join(', ')}`);
  port = next;
}

const current = () => {
  if (!port) throw new Error('port non branché (startEngine)');
  return port;
};
const call = name => (...args) => current()[name](...args);

export const fetchRows = call('fetchRows');
export const apply = call('apply');
export const readSchema = call('readSchema');
export const selectRows = call('selectRows');
export const querySql = call('querySql');
export const journalStats = call('journalStats');
export const docIdentity = call('docIdentity');
export const isOwner = call('isOwner');
export const docChanges = call('docChanges');
export const downloadAttachment = call('downloadAttachment');
export const uploadAttachment = call('uploadAttachment');
export const listWebhooks = call('listWebhooks');
export const createWebhook = call('createWebhook');
export const webhookConditions = call('webhookConditions');
export const setWebhookEnabled = call('setWebhookEnabled');
export const renameWebhook = call('renameWebhook');
export const deleteWebhook = call('deleteWebhook');
export const deleteWebhookWithNotice = call('deleteWebhookWithNotice');
export const clearWebhookQueue = call('clearWebhookQueue');
export const postToHook = call('postToHook');
export const postRows = call('postRows');
export const publicRecords = call('publicRecords');
export const publicAccess = call('publicAccess');
export const shareInfo = call('shareInfo');
export const withLock = call('withLock');

// Texte pour la personne (messages d'erreur, résumés d'un passage, étiquette d'une colonne écrite
// dans le document).
export const t = (key, values) => current().text(key, values);

export const page = {
  visible: () => current().page.visible(),
  busy: () => current().page.busy(),
  onShow: callback => current().page.onShow(callback),
  onLeave: callback => current().page.onLeave(callback),
};

export const prefs = {
  read: name => current().prefs.read(name),
  write: (name, value) => current().prefs.write(name, value),
};
