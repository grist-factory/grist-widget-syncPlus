# Le moteur de syncPlus (`js/engine/`)

Ce dossier crée, lit, écrit et décide ; il ne dessine rien. Les écrans (`js/source/`, `js/target/`, `js/ui.js`…)
appellent le moteur, jamais l'inverse. Modules ES, sans bibliothèque ni étape de build.

**Version du moteur : `ENGINE_VERSION` dans `version.js`** (l'historique des versions y est aussi). Elle ne suit pas la version de syncPlus : elle
change quand le moteur change ce qu'il attend du port, ce qu'il écrit dans les documents ou le sens d'un champ des
codes (`CODE_FORMAT`). Majeure : un port, un nom de table ou un format qui ne se lisent plus comme avant.

## Règles

1. Rien ici n'utilise `document`, `window`, `location`, `navigator`, `localStorage` ni le global `grist`
   (`tests/unit/engine.test.mjs` le vérifie, ainsi que les imports : rien ne remonte vers `js/ui.js` ou un écran).
2. Tout ce qui sort ou entre passe par le `port` (`port.js`). Les modules importent de `port.js` les mêmes noms que
   l'ancien `js/grist.js` ; chaque appel est rendu au port courant, **au moment de l'appel** (rien n'est lu à l'import).
3. Les noms des tables que le moteur crée viennent du préfixe (`SYNC_TABLE`, `JOURNAL_PREFIX`, `destTableId` de
   `logic/common.js`), lus à l'appel et non à l'import.
4. Un texte lu par la personne vient de `port.text(clé, valeurs)` ou d'une erreur prévue (`failure('<code>')`, texte
   `error.<code>`). Le port rend **la clé elle-même** quand elle est inconnue : `errors.js` s'en sert pour reconnaître
   une erreur prévue.

5. Aucune fonction ne dépasse les seuils de l'outil d'audit de GFS (80 lignes, complexité 15, imbrication 5) : une fonction qui
   grossit se découpe en petites fonctions nommées, comme `createRestPort` (un groupe de requêtes par fonction du module),
   `lotFormula` (une étape par fonction) ou `diagnosticText` (une section par fonction). `tests/tools/mesure-moteur.mjs`
   le mesure avec les fonctions mêmes de l'outil (`GWAUDIT_DIR=<outil> node tests/tools/mesure-moteur.mjs`).
6. Le texte des formules de `Synchro` (`syncFormulas` : `keys`, `lot`, `state`) est celui que le moteur pose dans les colonnes
   des documents déjà partagés : il ne change pas d'un octet sans décision (version du moteur relevée, dite à GFS).
   `tests/unit/formulas-golden.test.mjs` compare ce texte à une référence (`tests/unit/golden/formulas.json`).

## Démarrer

```js
import { startEngine } from './engine/index.js';
startEngine({ port, prefix: '', version: '0.13.2' });   // une fois, avant tout appel ; le même préfixe pour un même document
```

- `version` : la version de l'application, écrite dans les codes d'invitation et de réponse (qui s'en servent pour
  avertir d'un code plus ancien ou plus récent). Facultative : `ENGINE_VERSION` à défaut. `appVersion()` la rend.

- `prefix` : texte de 0 à 32 caractères, majuscule en tête (`/^(?:[A-Z][A-Za-z0-9_]{0,31})?$/`, `TABLE_PREFIX_RULE`).
  **Défaut `''` : les noms d'avant** (`Synchro`, `Journal_<export>`, destinations au nom proposé). Avec `Gfs_` :
  `Gfs_Synchro`, `Gfs_Journal_<export>`, destinations `Gfs_<nom>`. Les colonnes (`Synchro_Export`, `id_sync`, `MajLe`…)
  font partie du protocole entre deux documents et ne changent pas. Deux documents qui s'envoient des données avec un
  lien public doivent avoir le même préfixe.
- `port` : voir ci-dessous. `setPort` le refuse s'il est incomplet (`port incomplet : …`).

## Le `port` (`PORT_SHAPE`)

| Groupe | Fonctions |
|---|---|
| Document, avec les droits de la personne | `fetchRows`, `apply`, `readSchema`, `selectRows`, `querySql`, `journalStats`, `docIdentity`, `isOwner`, `docChanges` |
| Pièces jointes | `downloadAttachment`, `uploadAttachment` |
| Webhooks (propriétaires) et envois directs | `listWebhooks`, `createWebhook`, `webhookConditions`, `setWebhookEnabled`, `renameWebhook`, `deleteWebhook`, `deleteWebhookWithNotice`, `clearWebhookQueue`, `postToHook`, `postRows` |
| Document public, lu sans identifiant ; document d'une clé de formulaire | `publicRecords`, `publicAccess(base)` : le droit du lien public du document (`'viewers'`, `'editors'`, `''` s'il est fermé, `null` si Grist ne répond pas), `shareInfo(adresse)` : nom, identifiant, dossier et équipe du document que désigne la clé (requête anonyme à `…/api/s/<clé>`), `null` si la clé n'existe pas, une erreur `shareUnreadable` si Grist ne répond pas |
| Environnement | `withLock(nom, fn)`, `text(clé, valeurs)` |
| `page` | `visible()`, `busy()`, `onShow(fn)`, `onLeave(fn)` |
| `prefs` | `read(nom)`, `write(nom, valeur)` : deux petites valeurs par navigateur (dernière visite d'un document, identifiant du navigateur), jamais une donnée de table |

Contrat de `docChanges(since)` : rend `null` si l'hôte ne sait pas comparer (droits), sinon `{ hash, tables }` où `hash` est le
nouvel état de départ et `tables` l'ensemble des tables touchées depuis `since`, ou **`null` = inconnu, tout relire** (pas
d'état de départ, état que Grist ne connaît plus, table renommée, Grist muet). Un ensemble **vide** ne se rend que pour un
état connu et sans changement : un état perdu ne doit jamais passer pour « rien n'a changé » (`tests/unit/doc-changes.test.mjs`).

**Tout ce qui passe par REST est écrit une fois, dans `createRestPort`** (voir plus bas) : `selectRows`, `querySql`,
`journalStats`, `docChanges`, `isOwner`, les pièces jointes, les webhooks, les envois directs, `publicRecords`, `publicAccess`, `shareInfo`.
Un hôte écrit `fetchRows`, `apply`, `readSchema`, `docIdentity`, `withLock`, `text`, `page`, `prefs`, et donne `http` à
`createRestPort` pour le reste.

syncPlus seul remplit ce port avec `js/sync-port.js`. `tests/unit/engine-fake.mjs` en est un autre : un Grist en mémoire.
`readSchema` rend un schéma bâti par `logic/schema.js` (`schemaFrom(lignes de _grist_Tables, lignes de _grist_Tables_column)`).

## Les requêtes REST : `createRestPort({ docApi, http })` (`rest-port.js`)

```js
import { createRestPort, startEngine } from './engine/index.js';
const rest = createRestPort({ docApi: { fetchRows }, http });
startEngine({ port: { fetchRows, apply, readSchema, docIdentity, withLock, text, page, prefs, ...rest } });
```

`docApi.fetchRows(tableId)` : les lignes d'une table du document (celles de `_grist_Triggers` y sont lues pour la condition
des webhooks). Ce que le moteur écrit lui-même, une fois pour tous les hôtes : la condition d'un webhook relue après sa
création (webhook effacé et erreur `gristTooOld` si elle manque), l'adresse de webhook que l'instance n'autorise pas (erreur
`webhookForbidden`, voir « Erreurs »), la file d'un webhook vidée avant son effacement, l'avis de
fin envoyé avant d'effacer (un lien mort ne retient rien), l'envoi direct limité à l'instance du document (`otherInstance`),
les clés abrégées dans les messages d'erreur, la comparaison d'états de `docChanges` (état perdu = inconnu, jamais « rien »),
le SQL de `selectRows` et `journalStats`.

**`http` (fourni par l'hôte, qui ajoute le jeton et décide d'où l'on peut écrire) :**

| Fonction | Rôle |
|---|---|
| `request(méthode, chemin, { body, params, full, timeout })` | REST du document courant. `chemin` relatif à son adresse (`/webhooks`, `/webhooks/queue/<id>`, `/sql`, `/compare`), `params` : paramètres d'adresse (texte, l'hôte les encode), `body` : objet envoyé en JSON, `full` : avec les droits de la personne (sinon lecture seule ; `/sql` et `/compare` demandent `full`), `timeout` en ms. Rend `{ status, body }` (`body` : le JSON lu, `null` si vide). |
| `anonymous(méthode, adresse, { body, timeout })` | Requête **sans jeton** à une adresse complète : clé d'un formulaire (POST de lignes), fiche d'un partage (`…/api/s/<clé>`), document public. L'hôte ne l'autorise que vers le serveur du document. Rend comme `request`. |
| `download(numéro)` | Les octets (`Uint8Array`) de la pièce jointe du document. |
| `upload(nom, octets)` | Dépose un fichier, avec les droits de la personne ; rend son numéro. |
| `docBaseUrl()` | L'adresse REST du document (`https://hôte[/o/équipe]/api/docs/<id>`), ou une promesse qui la rend. |

**Erreurs :** sur tout refus (statut hors 2xx), `request`, `anonymous`, `download` et `upload` **lèvent** une erreur qui porte
`status` (nombre) et `message` (le début du texte de la réponse, 200 caractères au plus) ; sans réponse (réseau muet,
délai dépassé), une erreur **sans** `status`. Le moteur distingue les deux : un refus devient une réponse `{ status }` qu'il
interprète (403 = pas propriétaire, 404 = clé inconnue…), un réseau muet remonte ou vaut « inconnu » selon la fonction.
Depuis la 4.2.0, un 403 dont le `message` contient « url is forbidden » (Grist : « Provided url is forbidden », l'adresse du
webhook n'est pas dans la liste `ALLOWED_WEBHOOK_DOMAINS` de l'instance) devient l'erreur `webhookForbidden`, pas `ownerOnly` :
l'`http` de l'hôte doit donc bien mettre le texte de la réponse dans `message`, et l'hôte fournir le texte `error.webhookForbidden`
(« demandez à l'administrateur de l'instance d'ajouter son adresse à la liste des domaines autorisés pour les webhooks »).
`tests/unit/rest-port.test.mjs` joue ces cas sur un `http` en mémoire ; `js/grist.js` est l'`http` de syncPlus (jeton `auth=`,
liste des instances).

## Les enchaînements des assistants, sans fenêtre

Un assistant de l'écran de syncPlus est une suite d'étapes ; ce que chaque étape fait quand la personne la valide est dans
le moteur, en fonctions qui prennent des données simples et rendent des données (aucun nœud, aucun texte d'écran :
la personne ne lit que `port.text` ou une erreur prévue, `failure('<code>')`). L'écran (ou GFS) garde les fenêtres,
les boutons et l'ordre des écrans. `tests/unit/engine-flow.test.mjs` joue tout le parcours (SOURCE, CIBLE, un lot
signé recopié) sur deux Grist en mémoire, sans écran.

SOURCE (`source/export.js`, `source/invite.js`, plus `source/actions.js` pour révoquer, suspendre, arrêter) :

| Fonction | Prend | Rend |
|---|---|---|
| `saveChosenExport({ exp?, name, selection, links?, style?, notes?, tableNote?, rules? })` (`style` : envoyer aussi la mise en forme des colonnes, voir « Mise en forme » ; `notes` : les descriptions des colonnes ; `tableNote` : celle de chaque table, voir « Descriptions ») | `selection` : `[{ table, columns: [identifiants cochés], filter }]` | `{ id, name, tables, changed, created }` (`created` : l'export tel que l'écran des destinataires l'attend) |
| `finishEdit(exp, { name, changed }, progress?)` | l'export modifié | lignes renvoyées (ou `null` si le renvoi attend son tour) |
| `startInvitation(exp, { renforce? })` | l'export | `{ exp, entry, secret }` : `secret` n'est gardé nulle part |
| `invitationCode(exp, entry, secret, retour?)` | | `{ code, expire, backCode }` (le code à transmettre ; `from` porte l'équipe du document et le nom retenu par `rememberDocName`) |
| `rememberDocName(nom)`, `sourceDocName()` (`source/synchro.js`) | le nom que la personne donne à ce document (un widget ne peut pas lire le sien) ; vide : effacé | rien, puis le nom retenu dans la note SOURCE (`nomDoc`) |
| `docNameFrom(saisie, { origin, docId })`, `parsePageAddress(adresse)` (`logic/codes.js`, 4.12.0) | ce que la personne a tapé ou collé dans le champ du nom : un nom, ou l'adresse de la page de CE document (le nom y est lu, sans accent ni ponctuation) | `{ kind, name }` : `typed`, `address`, ou un nom vide avec `noName`, `otherDoc`, `otherSite`, `invalid` (jamais l'adresse) |
| `renewInvitation(inv)` | l'invitation en attente | `{ entry, secret }`, ou `null` pour un Échange |
| `enablePublicLink(exp)` | | le code du lien public |
| `startReturn(exp, …)` puis `linkReturn(inv, lien)` | Échange : le lien du formulaire de retour | `{ entry, secret, retour }` |
| `checkReply(exp, inv, texte)` | la réponse collée | la réponse lue et contrôlée chez Grist (`share`, `code` de contrôle, `keys`, `url`, `tables`) |
| `approveReply(exp, inv, reply)` | | l'identifiant du webhook créé |
| `loadPlan(exp)`, `sendExisting(exp, progress?)` | | ce que l'envoi de l'existant coûterait, puis son envoi |

CIBLE (`target/receive.js`) :

| Fonction | Prend | Rend |
|---|---|---|
| `readInvitation(texte)` | le code collé | l'invitation contrôlée (instance, validité, propriétaire pour un Échange, `share`, `backCode`) |
| `knownReception(invitation)`, `canRelink(known, invitation)`, `relinkReception(known, invitation)` | | la réception de cet export qui existe déjà, si elle peut reprendre, et sa reprise (nouvelles clés) |
| `checkDestinations(invitation, plans)` | `plans` : `[{ tb, dest }]` | `{ schema, existing }` : les destinations qui existent déjà (à faire correspondre : `plan.map`, `plan.match`) |
| `createReception(invitation, plans, { reserve?, options?, arrange? })` | `arrange` : vrai pour ranger la page du formulaire sous celle de la destination et noter la réception dans son partage (faux par défaut : la mise en page du document est celle de l'hôte) | `{ journal, note, created }` : le journal, son formulaire, les destinations |
| `markReceptions(receptions)`, `readLost()`, `dismissLost(lost)` (`target/lost.js`) | `receptions` : `[{ journal, note }]` | pose la marque d'une réception sur le partage de son formulaire (`description` de `_grist_Shares`) ; rend les réceptions dont le journal n'existe plus (`{ journal, name, shares, dests: [{ dest, there }] }`) ; retire l'avis (les partages) |
| `ensureForm(journal, { below?, note? })` (`pages.js`) | `below` : tables qui reçoivent, `note` : la note de la réception | publie le formulaire ; à sa création, la page se range sous celle de `below` (`placeBelow`) et le partage garde la marque de `note` |
| `undoReception({ journal, created })` | | défait la réception qu'on vient de créer |
| `sourceOf(invitation)` | l'invitation lue | le document de la SOURCE tel que la note du journal le garde (`email`, `docId`, `team`, `docName`) ; en Échange, nom et équipe lus chez Grist l'emportent. L'hôte en fait un lien avec `docUrl(origin, team, docId)` (`logic/codes.js`, `origin` : l'instance de **son** document, jamais celle d'un code) |
| `receptionReply({ journal, note }, lien)` | le lien du formulaire collé | `{ code, control }` : le code de réponse et le code de contrôle |
| `myEmail(journal)` | | l'e-mail de la personne connectée, calculé par Grist |
| `restyle(journal, elements?)` (`target/loop.js`) | `elements` : `{ style?, notes?, table?, formulas? }` (défaut : les trois premiers, jamais `formulas` ; l'hôte lit ce que l'export envoie dans `entry.sends` de la note) | la CIBLE reprend de la SOURCE, dans les colonnes reçues, les éléments demandés : formats, en-têtes et règles (`style`), descriptions des colonnes (`notes`), description de la table (`table`), formules de colonne (`formulas`, voir « Formules »), en remplaçant ce qui a été retouché ici |
| `readDocFormat()`, `alignDocFormat(wanted)` (`target/style.js`) | `wanted` : `{ locale?, currency? }` (`formatGap(source, ici)` dit l'écart) | la langue et la monnaie de ce document ; `alignDocFormat` les écrit dans `_grist_DocInfo` (à ne faire que sur un geste d'un propriétaire, c'est un réglage du document entier) |

Ce que ces fonctions supposent du port : `shareInfo` (document de la clé du formulaire), `createWebhook` (condition
relue), `isOwner`, `docIdentity`, `apply`, `fetchRows`, `readSchema` et `withLock` pour les notes ; **aucun accès à
l'écran**.

**Le jugement d'un lien collé est dans le moteur, jamais dans un écran** (consigne 005). L'écran affiche des champs, des cases
et des erreurs ; le moteur refuse :
- un lien qui écrirait dans un autre document (`shareOtherDoc`, par `shareInfo` : à la lecture d'une invitation d'Échange, à
  `checkReply`), une clé inconnue ou coupée (`shareUnknown`), Grist muet ou une réponse inattendue (`shareUnreadable`), un
  lien de formulaire qui n'écrit pas dans ce journal (`linkTest`, `linkElsewhere`, par `testUrl`) ;
- une autre instance (`otherInstance`), une invitation périmée (`invitationExpired`, 7 jours ; `invitationState(inv)` dit
  `'link'`, `'expired'` ou `'valid'`), un code plus récent que le moteur, une réponse qui ne vient pas de cette invitation ;
- en sécurité renforcée, un code de contrôle non comparé : `approveReply(exp, inv, reply, { compared })` et, pour un Échange
  renforcé, `checkDestinations(invitation, plans, { compared })` et `createReception(…, { compared })` lèvent
  `codeNotCompared` avant toute écriture si `compared` n'est pas vrai (`mustCompare(invitation)` dit si la CIBLE doit le
  demander) ; la case à cocher est à l'écran, la règle est ici ;
- une signature fausse (`checkSigned`), une clé publique remplacée en route (le code de contrôle change : `controlCode` y met
  ce que chaque côté a lu). Essais : `tests/unit/engine-links.test.mjs`.

Aussi sans écran : le contrôle des webhooks « tenus à jour » (`source/hook-check.js` : `checkHooks(webhooks)`, une
vérification par heure et par destinataire, rend vrai si une fiche a changé ; `hookCheck(id)`, `personLabel(webhook)`) et le
diagnostic à copier (`diagnostic.js` : `diagnostic({ version, served, readOnly, agent })` rend le texte, rien d'autre que
ce que l'hôte dit lui-même n'est supposé : le moteur lit le document par le port).

## Mise en forme des colonnes (2.7.0)

Un export dont `style` est vrai envoie, avec la description signée des colonnes, ce que Grist range dans les options d'une
colonne en plus du format : couleurs et gras des en-têtes, alignement, monnaie résolue, règles de mise en forme conditionnelle
(`rules` : `[{ when, fillColor, textColor, fontBold… }]`), et la langue et la monnaie du document (`doc`, sur la première
colonne). Rien n'est envoyé sans `style` : la description est celle d'avant, octet pour octet.
- **Une règle n'est jamais une formule copiée.** Une règle est une formule Python dans une colonne cachée de la SOURCE ;
  `logic/rules.js` ne la reprend que si elle entre dans une grammaire courte (`parseRule` : `et`/`ou`/`non`, comparaisons,
  `in` avec une liste littérale, `is None`, `+ - * /`, `TODAY()`, `$Col` ou `rec.Col`, nombres, textes sans guillemet ni
  barre oblique ni caractère de contrôle ou de sens d'écriture ; 300 caractères, 60 nœuds, profondeur 12). La CIBLE
  **réécrit** la formule (`printRule`) avec les noms de colonnes d'ici ; une colonne absente d'ici, ou un mot hors grammaire,
  fait tomber la règle. Essais : `tests/unit/rules.test.mjs`, `robustness.test.mjs` (tirage de règles abîmées).
- **CIBLE** : seules les colonnes que le moteur a créées prennent la mise en forme, une fois (`styled` dans la note) ; une
  retouche d'ici reste ; `restyle` remplace sur demande. La langue du document n'est jamais changée par un passage : l'écart
  est une information (`formatGap`), le réglage est `alignDocFormat`. En Échange, la mise en forme ne part pas.
- Essais : `tests/unit/engine-format.test.mjs` (SOURCE fr-FR vers CIBLE en-US sur deux Grist en mémoire), e2e `ONLY_FORMAT=1`.

## Descriptions (2.8.0)

Un export dont `notes` est vrai envoie la description de chaque colonne (`desc`, texte, vide s'il n'y en a pas : la clé dit que
l'export l'envoie) ; un export dont `tableNote` est vrai envoie celle de sa table (`tdesc`, sur la première colonne). Les deux sont
dans la description signée des colonnes, nettoyées et bornées (`logic/descriptions.js` : `cleanNote`, 300 et 500 caractères) ; elles
n'entrent pas dans la comparaison qui décide d'un renvoi (`withoutOpts`) : changer un texte ne renvoie aucune ligne.
- **SOURCE** : la description de la table est celle de la section de données brutes (`_grist_Tables.rawViewSectionRef` →
  `_grist_Views_section.description`, vérifié : c'est ce que la page « Données brutes » montre). Le moteur lit `_grist_Views_section`
  par `fetchRows`, seulement quand un export envoie la description de sa table. `elementCounts(schema, tables, sections)` (`logic/exports.js`)
  dit à l'écran combien de colonnes ou de tables chaque case concerne.
- **CIBLE** (`target/describe.js`, `planNotes`) : comme pour les formats, seules les colonnes que le moteur a créées reçoivent la
  description, une fois (`described` dans la note) ; la table la reçoit quand la sienne est vide (`tabled`). Une description
  retouchée ou effacée ici n'est pas refaite. `restyle(journal, { notes: true })` / `{ table: true }` les remplacent, vide comprise.
  La note garde aussi `sends` (`'style'`, `'notes'`, `'table'` : ce que l'export envoie), que l'hôte lit pour proposer les cases de
  « Reprendre ». Jamais sur `id_sync`, jamais en Échange.
- **Port** : inchangé. Un hôte dont le `fetchRows` lit `_grist_Views_section` envoie et reçoit les descriptions de table ; sans cela
  seules celles des colonnes passent. Essais : `tests/unit/engine-notes.test.mjs`, e2e `ONLY_FORMAT=1`.

## Formules de colonne (2.9.0)

Un export dont `formulas` est vrai (`saveChosenExport({ …, formulas: true })`, jamais en Échange) envoie le texte de chaque vraie colonne de
formule (`fx`, vide pour une colonne qui n'en est pas une : la clé dit que l'export les envoie) dans la description signée des colonnes ;
ni formule de déclenchement, ni colonne Référence ou Pièces jointes. Nettoyé et borné par `logic/column-formulas.js` (`cleanFormula` :
1 500 caractères par formule, 20 000 par table, une formule trop longue ne part pas), hors de la comparaison qui décide d'un renvoi.
- **CIBLE** (`target/formulas.js`, `planFormulas`) : **un passage ordinaire ne pose jamais une formule**. Il les lit seulement et rend, par
  table, `formulas` dans le résultat de la table (`state.results`, `tableResult`) : pour chaque formule, `{ id, to, label, formula, state,
  problems, ok }` (`state` : `data`, `other`, `same`). `restyle(journal, { formulas: true })` pose celles qui n'ont pas d'objection
  (`ModifyColumn` : `isFormula`, `formula`) sur les colonnes que le moteur a créées (`own`) ; la colonne devient une colonne de formule et
  `copyColumns` ne l'écrit plus. Jamais sur une colonne qui existait déjà, sur `id_sync`, ni en Échange. Rien de plus dans la note.
- **Lecture** (`formulaProblems`) : refus d'office d'un mot interdit hors des textes et commentaires (`eval`, `exec`, `open`, `getattr`, `os`,
  `sys`…), de tout nom à doubles tirets bas (partout), de tout `import` hors de `SAFE_MODULES`, d'une colonne citée absente ou renommée
  ici, d'une table citée qui n'est pas une table de l'export. Le texte n'est jamais réécrit. **C'est un garde-fou, pas une preuve** : lire
  `SECURITY.md` (« Formules de colonne »).
- **Pour l'hôte** : ne proposer `formulas` qu'à un propriétaire, après avoir montré chaque formule lue (`state.results` → `formulas`) et son
  éventuelle objection, avec un message sur le Python et une confirmation explicite ; le moteur ne demande rien de plus. Sur une instance
  Grist sans bac à sable (vérifié : l'image Docker officielle laisse une formule lister les fichiers du serveur), ne pas proposer la case.
- **Port** : inchangé. Essais : `tests/unit/engine-formulas.test.mjs`, e2e `ONLY_FORMULAS=1`.

## Notes à l'abri des lecteurs (3.0.0)

Un lecteur d'un document (le lien public compris) lit `_grist_Tables_column` : Grist y vide le nom, le type, la formule et les **options**
des colonnes qu'il ne peut pas lire, mais pas leur **description** (vérifié sur Grist 1.7.22). Les notes du moteur (SOURCE :
`Synchro_Export` ; CIBLE : `Synchro_Ids` du journal et clé de signature de la colonne `id_sync` des tables reçues) sont donc dans les
**options** de la colonne (`widgetOptions`, clé `syncNote`), jamais dans sa description.
- **Version majeure** : un moteur 2.x lirait une colonne dont la description est vide et croirait la note vide (il pourrait la réécrire).
  Tous les onglets d'un même document doivent avoir le moteur 3 ; un document d'avant est lu tel quel puis déplacé.
- **Pour l'hôte, rien à faire** : `columnNote` (`logic/common.js`) lit les options d'abord, la description d'avant ensuite ; `noteAction`
  écrit les options (en gardant les autres clés) et vide la description d'une note d'avant. `moveNotes` (`note-move.js`) déplace ce
  qui reste dans une description : appelé par `ensureSyncTable` (SOURCE, propriétaire) et par chaque passage de recopie (CIBLE, sauf page
  en lecture seule), il relit le schéma sous un verrou avant d'écrire. Une description écrite à la main n'est jamais touchée (seule la
  note d'`id_sync` qui porte `signature` compte).
- **Règle d'accès de plus** : `keyAclRules` (mémo « Synchro : clé de signature cachée aux lecteurs ») cache la colonne `id_sync` des tables
  qui portent une clé (`signedTables`) à `user.Access == VIEWER`. Posée par `syncRules` (propriétaire), qui recharge le document si elle
  change. Un hôte qui n'appelle pas `syncRules` n'a pas cette règle : la clé reste lisible par les lecteurs.
- **Ce qui reste lisible** : la condition des webhooks (identifiant de l'export) et le journal d'une réception dont la case « réservé aux
  éditeurs » est décochée. Le mémo des webhooks (courriel du destinataire, document, équipe/nom) ne l'est plus depuis la 4.0.0, voir
  ci-dessous.
- **Port** : inchangé. Essais : `tests/unit/note-store.test.mjs`, `engine-note-store.test.mjs`, `acl.test.mjs`, `common.test.mjs` ; e2e (lecture
  anonyme des métadonnées, SOURCE et CIBLE), sonde `tests/e2e/tools/probe-public.mjs` (`STRICT=1`).

## Rien d'écrit avant la protection, mémo opaque (4.0.0)

Audit offensif du 12 novembre (415 routes de lecture, visiteur du lien public, lecteur, éditeur, détenteur de la clé d'un formulaire ; sondes
`tests/e2e/tools/probe-surfaces.mjs` et `probe-gaps.mjs`). **Version majeure** parce que le mémo d'un webhook ne dit plus rien du
destinataire : un moteur 3.x y lit un nom, y écrit encore la fiche, et reposerait des règles d'accès d'avant.
- **`protectSync()`** (`acl.js`) : crée la table `<préfixe>Synchro` vide (`createSyncTable`), pose les règles d'accès même si un assistant est
  ouvert (`syncRules({ force: true, strict: true })`) et rend vrai si le document va se recharger. L'hôte l'appelle **avant** d'ouvrir l'assistant
  d'export (syncPlus : `newExport` de `js/source/tab.js`, qui note la demande avec `askWizard` AVANT l'appel, la page étant rechargée avant qu'il
  ne rende, puis rouvre l'assistant avec `wizardAsked`). Il lève `rulesRefused` si Grist refuse les règles, `syncTableForeign` si une table
  nommée `Synchro` n'est pas celle du moteur. **`syncUnprotected()`** dit, sans rien écrire, si un Échange reçu écrirait dans une `Synchro` sans
  règles : l'hôte passe alors par `protectSync` avant (`showProtect` de `js/target/wizard.js`). Un hôte qui crée un export sans `protectSync`
  garde la fenêtre d'avant : la première ligne d'export, copie des colonnes envoyées, est lisible jusqu'à la pose des règles.
- **`ruleRefusal()`** : texte du dernier refus de Grist à poser les règles (une règle d'une personne nomme une colonne effacée : « Invalid
  columns in rules for table X: Y »), `null` sinon. L'hôte le montre aux propriétaires (`rulesRefusedNotice` dans syncPlus) et bloque le nouvel export.
  Le moteur ne touche jamais aux règles d'autrui.
- **Mémo = jeton** : `MEMO_TOKEN` (`r-` et douze chiffres hexadécimaux, `isMemoToken` de `logic/notes.js`). La fiche (courriel, document,
  équipe/nom) est dans la note de la SOURCE (`dest`, `putDest`, `destOf`, `staleDest`, `dropDest`) ; `rememberDest(memo)` la range et rend le
  jeton **avant** `createWebhook` (`approveReply`, `wireExchange`) ; `readHooks()` rend les webhooks avec leur fiche remise dans `fields.memo`
  (`identifyHooks`, le jeton brut est dans `fields.memoToken`) ; `protectMemos()` (propriétaire, sous le verrou `gristsync-memos`) donne
  un jeton aux webhooks d'avant et retire les fiches des destinataires partis (`DEST_GRACE_S` = 600 s). L'hôte qui lisait `listWebhooks` pour
  montrer qui reçoit passe par `readHooks()`.
- **Port** : `renameWebhook(id, nom, mémo?)` prend un mémo facultatif (`createRestPort` l'envoie seulement s'il est donné) ; `PORT_SHAPE` ne change pas.
- **Éditeurs** : sans Échange, `ownerAclRules` n'est plus qu'un refus de `Synchro` (`-CRUD`) à qui n'est pas propriétaire, sans condition de
  ligne : Grist vide alors les options de `Synchro_Export` dans les métadonnées qu'un éditeur lit, donc la note de la SOURCE (fiches, clé privée
  d'une invitation) lui est cachée. Avec un Échange (`exchangeIds` non vide), les cinq règles d'avant restent et la note est lisible par ses éditeurs.
- **Essais** : `tests/unit/engine-protect.test.mjs`, `engine-memo.test.mjs`, `acl.test.mjs` ; e2e `ONLY_PROTECT=1` (vrai Grist : règles avant
  la première ligne, refus d'une règle orpheline dit, Échange avec l'étape de protection, mémos opaques lus en anonyme).

## Effacer l'historique sur demande (4.1.0)

Antoine, après la carte « Combien de temps garder les valeurs d'une ligne supprimée dans le journal de la CIBLE ? » (réponse « Comme aujourd'hui ») :
« un bouton pour effacer manuellement l'historique et nettoyer les journaux, côté CIBLE et SOURCE ». **Rien ne se fait seul** ; l'hôte appelle, après une confirmation.
- **`cleanJournal(journal)`** (`target/clean.js`, sous le verrou `gristsync-consolidation`) rend `{ before, values }` (ou `null` si ce n'est pas une réception) :
  vide `Sync_Avant` des versions d'ajout, de modification et de suppression (l'avant des modifications, le numéro des lignes supprimées), vide
  `Synchro_Donnees` de la dernière version d'une clé supprimée ou partie (`cleanPlan` de `logic/clean.js`), **rescelle** ces lignes avec la clé de
  signature de l'export (`sealing` de `target/loop.js`, sans quoi le passage suivant les prendrait pour forgées), et note `histo` (secondes) dans la note du
  journal : `tableResult` ne montre dans l'historique que ce qui est arrivé après `max(dernière visite, histo)`. La clé, l'heure, la case Supprime et l'état
  d'une version restent : elles décident encore de ce qui est recopié (une version en retard ne ressuscite pas une ligne). **Rien n'est vidé** en Échange
  (les valeurs d'une ligne cochée Supprime servent à comparer) ni pour un changement `refus` (l'avant sert à le corriger).
- **`clearExportHistory(exportId)`** (`source/history.js`) : `clearEvents` (`logic/notes.js`) efface l'historique des envois de la note SOURCE ; les ajouts
  et retraits de destinataire restent comme repères (`cleared`, sans nom ni nombre, `eventsOf(note, id, { all: true })`) parce que `vanishedRecipients` (un
  webhook supprimé à la main) et `unkeyedRecipients` (une clé de signature perdue) s'appuient sur eux ; le reste est oublié, les avis de baisse de lignes
  compris. Puis il appelle `cleanJournal` pour les journaux de retour de cet export (Échange).
- **Ce qui n'est pas touché** : les lignes des tables, les webhooks, `Synchro`, et l'historique propre à Grist (Ctrl+Z, « Historique du document »), auquel
  le moteur n'a pas accès.
- **Port** : inchangé. Essais : `tests/unit/engine-clean.test.mjs` (dont un contrôle que, sans le nouveau sceau, le passage suivant rejette la ligne), e2e
  `ONLY_CLEAN=1` (vrai Grist, CIBLE et SOURCE).

## Le widget sur la page d'une table reçue (4.3.0)

Antoine : « ajouter sur la carte de réception un bouton « Ajouter le widget à la page de la table reçue » ». **Rien ne se fait seul** : l'hôte appelle, après une
fenêtre qui dit ce qui va changer. À savoir pour l'hôte : **un seul widget ouvert suffit pour tout le document** (`passAll` parcourt tous les journaux, donc toutes
les réceptions, toutes les tables d'un export multi-tables et leurs Références, dans le bon ordre), mais il ne tourne que page ouverte et visible, et une table
créée par le moteur a sa propre page, sans lui : ce bouton le pose là où la personne reste.
- **`widgetSpots(tables, url)`** (`pages.js`) rend une `Map` table -> `{ view, there }` : `view` est la page de la liste qui montre la table (`destPageViews`, `null`
  si elle n'en a pas), `there` vrai si une section « Personnalisée » de même adresse (`widgetAddress` : sans requête, fragment, `index.html` ni barre finale, http(s)
  seulement) y est déjà. Trois lectures de métadonnées.
- **`addWidgetToPage(table, url)`** : ajoute à cette page une section « Personnalisée » (`CreateViewSection(…, 'custom', …)` puis `options`, voir
  `customOptions` de `logic/page-widget.js`) **sans l'accès accordé** (`access: 'none'`) : Grist le demande à la personne dans son panneau de droite, le moteur ne se
  donne jamais l'accès complet. Sous le verrou `gristsync-widget-page` (deux onglets qui cliquent ensemble ne posent pas deux sections). Rend `{ added, view }` (`added`
  faux : il y était déjà). Lève `noPageForTable` (table sans page, ou inconnue), `badWidgetUrl` (pas un lien http(s)) ; une personne qui ne peut pas changer la
  structure du document reçoit le refus de Grist. L'adresse est **donnée par l'hôte** (le moteur ne lit pas `location`) ; si une section du document est déjà ce widget,
  son adresse est reprise telle que la personne l'a écrite (`sectionUrl`).
- **Vérifié dans un Grist 1.7** : `CreateViewSection` accepte `'custom'` sur la page d'une table ; ajouter la section à une autre page que celle du widget ne recharge pas
  le widget ; le widget de la nouvelle section affiche son message d'accès (`start.access`) jusqu'à « Accepter » dans le panneau de droite, puis recopie.
- **Port** : inchangé. Essais : `tests/unit/page-widget.test.mjs` (adresses, lecture d'une section, lieu), `engine-widget-page.test.mjs` (ajout, deuxième clic, refus), e2e
  `ONLY_WIDGETPAGE=1` (vrai Grist : bouton, fenêtre, section sans accès, accès accepté dans Grist, recopie par ce widget-là).

## Références entre tables, choix par colonne (4.11.0)

Antoine, 12 novembre : « lorsqu'il y a des références dans les tables envoyées, côté source, peut-on l'indiquer ? et demander si l'user veut
envoyer le contenu uniquement en valeur ou ajouter la table/colonnes utilisées pour conserver les relations ? et dans ce cas il faut que côté cible
on refasse les références fonctionnelles » ; choix sur la carte : « Par colonne, tables ajoutées ».
- **SOURCE** : `linkOffers({ chosen, columnsOf, picked, choices, saved })` (`logic/links.js`) donne, pour chaque colonne Référence (`Ref:T`) ou Liste de
  références (`RefList:T`) cochée, `{ key, table, id, label, list, target, shown, inside, ok, why, link }` et `pulled` (table à ajouter -> colonnes affichées
  requises, en cascade). Par défaut le lien est gardé quand la table visée est cochée, sinon les valeurs seules partent (rien ne s'ajoute sans le choix) ;
  `ok` est faux sans colonne affichée (`numbers`) ou si cette colonne ne part pas (`hidden`). L'hôte ajoute les tables de `pulled` à la `selection`
  (colonnes affichées seulement, plus ce que la personne y prend : syncPlus lui offre depuis la 0.28 la colonne affichée seule, toute la table ou des colonnes
  au choix, `js/source/pull.js`, sans rien changer au moteur) et passe à `saveChosenExport({ links })` un `Set` de `refKey` (`Table.Colonne`) ; `true`
  garde l'ancien sens (les Références seules, pas les listes). Une liste qui garde son lien porte `link` et `list: true` dans la description signée des
  colonnes (`schemaText`, `exportSchema`) ; le lot porte les clés des lignes visées (`Synchro_Cle_<colonne>`, une liste pour une liste : le texte des formules
  de `Synchro` ne change pas, `.id_sync` d'un ensemble de lignes rend la liste).
- **CIBLE** : `planLinks` rend en plus `text` (colonnes créées par le moteur, restées du texte parce qu'elles étaient remplies) ; une Liste de références est
  convertie comme une Référence (`ModifyColumn` en `RefList:<table>`, `visibleCol`, `SetDisplayFormula`), ses cellules valent `['L', numéros…]` (`null` si
  aucune ligne visée n'est là) et sont complétées à l'arrivée d'une ligne visée (`fillLinks`, `fillable` : vide, éléments disparus ou ligne manquante ;
  cas limite : un élément retiré à la main d'une liste qui n'a plus que des lignes qui existent est remis, la SOURCE fait foi). `relink(journal)` (sur le clic
  d'un propriétaire, après une confirmation) convertit toutes les colonnes de `relinkable` (résultat de la table : `{ from, to, list, target }`) et leurs cellules
  reprennent exactement le lien envoyé (`relink: true` sur la spécification, voir `fillable`).
- **Port** : inchangé. Essais : `tests/unit/links.test.mjs`, `engine-refs.test.mjs` (SOURCE puis CIBLE sur deux Grist en mémoire, liste incomplète
  puis complétée, `relink`), e2e `ONLY_LINKS=1` (vrai Grist).

## Forme des codes relevée (5.0.0)

`CODE_FORMAT` (`logic/codes.js`, exporté) passe de 1 à 2. **Pourquoi** : une CIBLE d'avant la 4.11.0 ferait d'une colonne `list` (Liste de références) une
Référence simple ; le seul endroit où un moteur plus ancien peut être arrêté avant d'écrire quoi que ce soit est la lecture d'un code. **Ce qui change** :
la valeur de `f` dans les invitations et les réponses, rien d'autre (aucun champ n'a changé de sens). **Effets** : une CIBLE dont le moteur est plus ancien
refuse l'invitation avec `codeNewer` (valeurs `theirs` = version du code, `mine` = version d'ici, texte `error.codeNewer` à montrer tel quel) ; une
SOURCE plus ancienne refuse de même la réponse d'une CIBLE à la forme 2 ; les codes de forme 1 déjà faits sont lus. Une liaison déjà branchée n'est pas
touchée (les lots se lisent dans le journal). **Règle pour la suite** : un changement qui peut faire mal lire un journal à un moteur plus ancien, sans que
le code change, relève `CODE_FORMAT` dans la même version, et le moteur passe à la majeure suivante. Essais : `tests/unit/codes.test.mjs`,
`engine-links.test.mjs` (refus des deux côtés, texte français et anglais, rien d'écrit chez celui qui refuse).

## Ce que le moteur écrit dans un document

- SOURCE : la table `<préfixe>Synchro` (une seule table technique), les colonnes `id_sync`, `MajLe`, `RecalculLe` de
  chaque table envoyée, des webhooks (via le port), des règles d'accès dont le mémo commence par « Synchro : ».
- CIBLE : une table `<préfixe>Journal_<export>` par réception avec sa page et son formulaire, les tables de destination
  (colonne `id_sync`), des règles d'accès, des pièces jointes.
- Tables internes lues ou écrites : `_grist_Tables`, `_grist_Tables_column`, `_grist_Views`, `_grist_Views_section`,
  `_grist_Views_section_field`, `_grist_Pages`, `_grist_Shares`, `_grist_ACLResources`, `_grist_ACLRules`,
  `_grist_Attachments`, `_grist_DocInfo` (lue ; écrite seulement par `alignDocFormat`, sur un geste d'un propriétaire).

## Textes

Les clés que le moteur demande au port (`port.text`) sont toutes dans `i18n/fr.json` et `i18n/en.json` :
`recv.archive.col`, `recv.lock.waiting`, `recv.result`, `recv.result.none`, les messages d'erreur `error.<code>` des
erreurs prévues, et les 86 clés `diag.*` du diagnostic (`logic/diagnostic.js` reçoit `t` en paramètre et reste pur ; les
nombres y sont donnés en texte, sans séparateur de milliers : le diagnostic se colle dans un message). Reste **en français,
écrit dans le document** : les mémos des règles d'accès (« Synchro : réservée aux propriétaires »…), qui sont des données
lues par des personnes de langues différentes et qui servent à reconnaître les règles du widget.

## Renforcer la sécurité d'un partage d'avant les clés (4.4.0)

Un partage branché avant les clés de signature (Alpha) n'a pas de clé propre au destinataire. **Rien n'est imposé** : il continue d'arriver
tel quel. Le renforcer = une invitation de la SOURCE qui **remplace** l'envoi de cette personne (`startReinforcement(exp, hook)`, `canReinforce`),
reprise par la CIBLE comme une nouvelle invitation d'une réception connue (`relinkReception`).
- **CIBLE** : la note du journal garde `renf` (`logic/reinforce.js`) : `{ at }` quand le code est collé (seulement si la réception n'avait ni
  sceau ni clé, `isUnsignedReception`), `{ at, done }` à la première livraison signée vue (`unpack`, `finishRenf`). Entre les deux, `checkSigned(...,
  { grace })` accepte les envois **sans** signature (l'ancien webhook de la SOURCE n'a pas encore été remplacé) ; une mauvaise signature reste rejetée, une
  ligne `fin` n'est jamais tolérée. Au bout de 7 jours (`GRACE_S`), l'ancien envoi est refusé (`renfState` = `expired`) : l'hôte dit « interrompu » et
  propose de renvoyer la réponse ou `revertReinforcement(journal)` (retire clé publique, sceau et attente ; permis tant que ce n'est pas fini).
- **SOURCE** : l'invitation porte `replaces` (id du webhook). `approveReply` crée le nouveau webhook avec sa clé, **supprime l'ancien sans avis de fin**
  (la CIBLE ne doit pas se croire coupée), note l'événement `reinforce` (pas `join` : le compte des destinataires ne change pas) et laisse l'export
  intact ; `replacedHook` refuse une réponse d'un autre document (`reinforceOtherDoc`). `controlResend(exp, inv, progress)` renvoie ce qui a changé
  depuis l'invitation : la livraison signée qui finit le renforcement. Un Échange ou un lien public ne passent pas ici (`reinforceNot`).
- **Port** : inchangé, ni table ni `CODE_FORMAT`. Essais : `tests/unit/engine-reinforce.test.mjs`, e2e `ONLY_RENF=1` (vrai Grist, des deux côtés).
