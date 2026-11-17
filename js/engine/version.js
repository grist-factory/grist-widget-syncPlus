// Version du moteur. Elle ne suit pas celle de syncPlus : elle change quand le moteur change ce qu'il
// attend du port, ce qu'il écrit dans les documents, ou le sens d'un champ des codes (CODE_FORMAT).
// Mineure : une fonction ou un réglage de plus, sans rien casser. Majeure : un port, un nom de table
// ou un format qui ne se lisent plus comme avant. Elle est dite dans GFS-ETAT.md avec le commit.
// 1.0.0 : le moteur sort de l'écran de syncPlus 0.13.2 (port, préfixe de tables, dossier à part).
// 2.0.0 (9 novembre 2026) : le port exige quatre fonctions de plus (`shareInfo`, `publicAccess`, `renameWebhook`, `journalStats`),
//         donc un port écrit pour 1.0.0 est refusé par `setPort` tant qu'il ne les a pas : c'est une version
//         majeure au sens ci-dessus. Elles sont toutes dans `createRestPort` (rest-port.js), qui écrit les
//         requêtes REST une fois pour tous les hôtes (l'hôte ne donne que `http`). S'y ajoutent les
//         enchaînements des assistants sans fenêtre (source/export.js, source/invite.js, target/receive.js),
//         le contrôle des webhooks (source/hook-check.js), le diagnostic (diagnostic.js, textes `diag.*` par
//         `port.text`), `version` dans startEngine, et le jugement d'un lien collé tout entier dans le moteur (consigne 005 :
//         `approveReply` et `createReception` exigent `compared` en sécurité renforcée, `invitationState`).
// 2.1.0 (9 novembre 2026) : la CIBLE est passive, elle applique toutes les suppressions de la SOURCE (la retenue des
//         grosses suppressions, `WAVE`, `WAVE_STRICT`, `decideWave`, `held`, est retirée) ; la SOURCE en est avertie après
//         coup (`watchRows`, événement `shrink`, `lignes` dans la note SOURCE). Ni port, ni nom de table, ni format de code
//         ne changent : mineure, mais un hôte qui montrait la carte « Appliquer / Ignorer » n'en a plus l'usage.
// 2.2.0 (9 novembre 2026) : le document de la SOURCE est dit à la CIBLE : l'invitation porte `from.team` et `from.docName` (le nom
//         saisi une fois par la personne, `rememberDocName` de `source/synchro.js` : un widget ne peut pas lire le nom de son
//         document), la note du journal les garde, et `docUrl` (`logic/codes.js`) refait l'adresse du document pour que l'hôte en
//         fasse un lien. Champs facultatifs, ignorés par une version d'avant : ni port, ni nom de table, ni `CODE_FORMAT` ne changent.
// 2.3.0 (9 novembre 2026) : les pièces jointes vont dans les deux sens d'un Échange. L'export de retour garde les
//         colonnes Pièces jointes (`exchangeTables`) ; un fichier reçu du partenaire ne lui est pas renvoyé (`o` dans
//         le suivi `fichiers`, `holdFiles`, `noteHeldFiles`) ; en Échange, une version attend ses fichiers avant
//         d'être recopiée (`waitingVersions`, `plan.waiting`). Ni port, ni nom de table, ni format de code ne changent.
// 2.4.0 (10 novembre 2026) : deux ajouts facultatifs, que l'hôte demande ou non. `createReception(…, { arrange: true })` range la
//         page du formulaire sous celle de la destination (`ensureForm(…, { below })`, `placeBelow`) et note la réception dans la
//         `description` du partage du formulaire (`receptionMark`) ; `markReceptions`, `readLost` et `dismissLost` (`target/lost.js`)
//         disent qu'une réception a existé quand son journal est supprimé. Sans `arrange`, rien ne change : ni port, ni nom de table,
//         ni format de code.
// 2.5.0 (10 novembre 2026) : `docUrl(origin, team, docId, name)` (`logic/codes.js`) écrit l'adresse d'un document comme Grist
//         l'écrit, `<instance>[/o/<équipe>]/<identifiant>/<nom>` (nom facultatif, `docSlug`), au lieu de `/doc/<identifiant>` que
//         l'instance DINUM n'ouvrait pas ; un espace personnel `docs-<numéro>` s'écrit `docs`. Seule l'adresse rendue change : ni port,
//         ni nom de table, ni format de code. Un hôte qui montrait l'adresse de `docUrl` l'obtient sous la nouvelle forme.
// 2.6.0 (10 novembre 2026, consigne GFS 006) : cinq fonctions du moteur passaient les seuils de l'outil d'audit (81 lignes ou plus,
//         complexité au-dessus de 15) : `createRestPort` (226 lignes), `lotFormula` (87), `journalFacts` (complexité 22),
//         `diagnosticText` (18) et `docUrl` (16, depuis la 2.5.0). Elles sont découpées en petites fonctions, **sans changer ce
//         qu'elles rendent** : le texte de `syncFormulas` (`keys`, `lot`, `state`), celui du diagnostic, ce que `docUrl` rend et les
//         requêtes que `createRestPort` fait sont identiques (tests/unit/formulas-golden.test.mjs, garde du texte octet pour octet ;
//         comparaison avant/après sur des milliers de cas pour le reste). La forme du port que rend `createRestPort` (ses vingt noms,
//         dans le même ordre) ne change pas. Aucune formule à réécrire dans les documents déjà partagés. Mineure par convention :
//         rien n'est ajouté ni retiré au port, aux tables ou aux codes.
// 2.6.1 (11 novembre 2026, audit avant la Bêta) : correctif, sans ajout ni retrait. `addEvent` (`logic/notes.js`) ne lève plus
//         d'erreur quand l'historique d'une note SOURCE retouchée à la main n'est pas une liste (il repart d'une liste vide) ; cinq
//         variables locales renommées (`logic/journal.js`, `logic/lost.js`, `logic/notes.js`, `source/estimate.js`,
//         `source/resend.js`). Port, tables, codes et texte des formules inchangés ; essai `tests/unit/robustness.test.mjs`
//         (lectures de données abîmées : aucune exception imprévue).
// 2.7.0 (11 novembre 2026, retour du porteur : une page de budget dupliquée gardait l'écriture américaine et la devise USD) : la
//         mise en forme des colonnes peut partir avec l'export (`saveChosenExport({ …, style: true })`, marque `fmt` par colonne et
//         `doc` sur la première dans la description signée des colonnes) : en-têtes, couleurs, alignement, monnaie résolue (celle
//         de la langue du document quand la colonne n'en a pas) et règles de mise en forme conditionnelle simples. Une règle n'est
//         **jamais copiée** : `logic/rules.js` la lit par une grammaire stricte (comparaisons, et/ou/non, listes littérales,
//         arithmétique, `$Col`), la CIBLE la réécrit avec ses propres noms de colonnes (`printRule`), ce qui sort de la grammaire
//         est abandonné. CIBLE : `target/style.js` (`styleColumns`, `readDocFormat`, `alignDocFormat`), `restyle(journal)`
//         (`target/loop.js`) pour reprendre la mise en forme sur demande ; langue et devise du document (`logic/docformat.js`) :
//         l'écart est dit, le réglage du document n'est écrit que par `alignDocFormat`, sur un geste d'un propriétaire. Lit
//         `_grist_DocInfo` (SOURCE et CIBLE). Ni port, ni nom de table, ni `CODE_FORMAT`, ni texte des formules ne changent : un
//         export sans `style` envoie exactement la description d'avant (essai `engine-format`, `formulas-golden`), une version
//         d'avant ignore les champs en plus.
// 2.8.0 (12 novembre 2026, demande du porteur : « les éléments de mise en forme, plus globalement tout ce qu'il serait bien de reprendre »,
//         d'après le widget d'import/export de structure) : les descriptions des colonnes et des tables peuvent partir avec l'export
//         (`saveChosenExport({ …, notes, tableNote })`, clés `desc` et `tdesc` de la description signée des colonnes, nettoyées et
//         bornées par `logic/descriptions.js`). CIBLE : `target/describe.js` les pose sur les colonnes créées par le moteur, une
//         fois, et sur la table si sa description est vide ; `restyle(journal, elements)` reprend sur demande les éléments choisis
//         (`style`, `notes`, `table`) ; la note de chaque table garde `sends`, `described`, `tabled`. Le moteur lit
//         `_grist_Views_section` (`fetchRows`). Ni port, ni nom de table, ni `CODE_FORMAT`, ni texte des formules ne changent.
// 2.9.0 (12 novembre 2026, demande du porteur : « également prévoir de pouvoir sync les formules […] une case à part et un message
//         qui demande si l'user est sûr de le vouloir avec les risques de passer du python ») : les formules des colonnes peuvent partir
//         avec l'export (`saveChosenExport({ …, formulas })`, clé `fx` de la description signée des colonnes, nettoyée et bornée par
//         `logic/column-formulas.js`). CIBLE : un passage ne pose jamais une formule, il les lit (`formulas` dans le résultat de chaque
//         table) ; `restyle(journal, { formulas: true })`, sur le clic d'un propriétaire après lecture, transforme en colonnes de formule
//         celles que le moteur a créées et dont la formule n'a pas d'objection (`target/formulas.js`). Ni port, ni nom de table, ni
//         `CODE_FORMAT`, ni texte des formules de `Synchro` ne changent.
// 3.0.0 (12 novembre 2026, vérification du lien public demandée par le porteur : « regarder si un user qui arrive sur le lien voit les
//         tables gérées par le widget », puis choix « Notes à l'abri, complet ») : les notes du widget (SOURCE : `Synchro_Export` ;
//         CIBLE : `Synchro_Ids` du journal et clé de signature d'`id_sync`) ne sont plus dans la description des colonnes mais dans leurs
//         options (`widgetOptions`, clé `syncNote`, voir `columnNote` de `logic/common.js`) : Grist vide les options d'une colonne qu'un
//         lecteur ne lit pas, pas sa description, et `_grist_Tables_column` se lit en anonyme sur un document public. Les documents
//         d'avant sont lus tels quels puis déplacés (`moveNotes` de `note-move.js`, appelé par `ensureSyncTable` et par chaque passage de
//         recopie, `legacyNoteActions` de `logic/note-store.js`) ; une règle d'accès de plus (`keyAclRules`, mémo `KEY_MEMO`) cache la
//         colonne `id_sync` des tables qui portent une clé de signature aux lecteurs, posée par `syncRules`. Majeure au sens ci-dessus :
//         un moteur 2.x ne lit pas les notes d'un document 3.x (il les croit vides et pourrait les réécrire), donc tous les onglets d'un
//         même document doivent avoir le moteur 3 (recharger les onglets ouverts). Ni port, ni nom de table, ni `CODE_FORMAT`, ni texte
//         des formules de `Synchro` ne changent.
// 4.0.0 (12 novembre 2026, audit des fuites d'information demandé par le porteur : « vérifier toutes les approches possibles qui seraient
//         exploitées pour accéder à la donnée en récupérant des infos mal protégées ») : MAJEURE parce que le mémo d'un webhook ne dit plus
//         rien du destinataire. Grist montre `_grist_Triggers` (mémo compris) à toute personne qui lit le document, lien public compris :
//         le mémo n'est plus qu'un jeton (`r-` et douze chiffres hexadécimaux), la fiche « e-mail · document · équipe/nom » est dans la note
//         de la SOURCE (`dest`, `putDest`, `identifyHooks` de `logic/notes.js`), remise dans les webhooks que lit le moteur (`readHooks`) ;
//         `rememberDest` la range avant de créer un webhook, `protectMemos` (propriétaires, à l'affichage) donne un jeton aux webhooks
//         d'avant et retire les fiches des destinataires partis. Un moteur 3.x lit le jeton comme un nom de destinataire et écrit encore la
//         fiche dans le mémo : `protectMemos` la reprend. Sont aussi dans cette version : (1) les règles d'accès de `Synchro` se posent AVANT la
//         première donnée d'un export (`protectSync` de `acl.js` : table créée vide, règles posées même pendant un assistant, le document se
//         recharge avant que l'assistant s'ouvre ; `syncUnprotected` pour un Échange reçu ; `createSyncTable` de `source/synchro.js`) ; (2) un
//         refus de Grist à poser les règles n'est plus tu (`ruleRefusal`, `syncRules({ strict })`) ; (3) sans Échange, `ownerAclRules` n'est plus
//         qu'un refus sans condition de ligne pour qui n'est pas propriétaire, ce qui cache aussi la note de la SOURCE aux éditeurs (Grist vide
//         les options d'une colonne illisible) ; avec un Échange, les règles d'avant restent. Port : `renameWebhook(id, nom, mémo?)` prend un
//         mémo facultatif (`createRestPort`), `PORT_SHAPE` ne change pas. Ni nom de table, ni `CODE_FORMAT`, ni texte des formules de `Synchro` ne
//         changent. Tous les onglets d'un même document doivent avoir le moteur 4 : un onglet 3.x resté ouvert repose les règles d'avant à
//         chaque affichage (le document se recharge) et réécrit la fiche dans le mémo ; recharger les onglets.
// 4.1.0 (12 novembre 2026, demande du porteur après la carte « Combien de temps garder les valeurs d'une ligne supprimée dans le journal de la CIBLE ? »,
//         réponse « Comme aujourd'hui » : « un bouton pour effacer manuellement l'historique et nettoyer les journaux, côté CIBLE et SOURCE ») :
//         deux fonctions de plus, sur demande seulement (aucun passage ne purge seul). `cleanJournal(journal)` (`target/clean.js`) vide dans un
//         journal reçu l'avant des modifications et le numéro des lignes supprimées (`Sync_Avant`) ainsi que les valeurs de la dernière version
//         d'une clé supprimée ou partie (`Synchro_Donnees`, rescellée avec la clé de signature de l'export), et note `histo` dans la note du
//         journal : avant cette heure, l'historique de la carte ne montre plus rien (`tableResult`). Rien n'est vidé en Échange (les valeurs y
//         servent à comparer) ni pour un changement refusé. `clearExportHistory(exportId)` (`source/history.js`) efface l'historique des envois de la
//         note SOURCE (`clearEvents` de `logic/notes.js` : des repères d'ajout et de retrait restent, sans nom ni nombre, pour les destinataires
//         disparus et les clés de signature) et nettoie les journaux de retour de cet export. Ni port, ni nom de table, ni `CODE_FORMAT`, ni texte
//         des formules de `Synchro` ne changent ; la note du journal gagne une clé facultative, ignorée d'un moteur plus ancien.
// 4.2.0 (12 novembre 2026, réponse du porteur au point 14 de l'audit de sécurité : sur DINUM les webhooks sont limités à l'instance ; ailleurs,
//         il faut demander à l'administrateur d'être dans la liste autorisée) : un code d'erreur de plus. Grist refuse par 403 « Provided url is
//         forbidden » un webhook dont l'adresse n'est pas dans la liste des domaines autorisés de l'instance (`ALLOWED_WEBHOOK_DOMAINS`, vérifié sur
//         Grist 1.7) ; le moteur rendait `ownerOnly` pour tout 403, donc « réservé aux propriétaires » à un propriétaire. `restOf` (rest-port.js) rend
//         maintenant `webhookForbidden` pour ce refus (reconnu au texte que l'`http` de l'hôte met dans `message`), `ownerOnly` pour les autres 403.
//         Un hôte ajoute le texte `error.webhookForbidden` ; sans lui, la phrase générique cite le code. Ni port, ni table, ni code, ni formule ne changent.
// 4.3.0 (12 novembre 2026, demande du porteur : « ajouter sur la carte de réception un bouton « Ajouter le widget à la page de la table
//         reçue » ») : deux fonctions de plus, que l'hôte appelle ou non (`pages.js`). `widgetSpots(tables, url)` dit, pour chaque table, la page
//         qui la montre et si le widget d'adresse `url` y est déjà ; `addWidgetToPage(table, url)` ajoute à cette page une section
//         « Personnalisée » sur `url`, **sans l'accès accordé** (`access: 'none'` : Grist le demande à la personne, le moteur ne se le donne
//         jamais), une seule fois (verrou `gristsync-widget-page`), et lève `noPageForTable` ou `badWidgetUrl`. L'adresse est donnée par l'hôte
//         (le moteur ne lit pas `location`) et reprise telle que la personne l'a écrite si une section du document est déjà ce widget
//         (`logic/page-widget.js` : `widgetAddress`, `customUrl`, `widgetSpot`, `sectionUrl`, `customOptions`). Ni port, ni nom de table, ni
//         `CODE_FORMAT`, ni texte des formules de `Synchro` ne changent.
// 4.4.0 (12 novembre 2026, syncPlus 0.21.0, validé par le porteur : « Renforcer la sécurité » d'un partage branché avant les clés de signature,
//         option B du 6 novembre : jamais imposé) : mineure, rien n'est ajouté au port ni aux tables, aucun `CODE_FORMAT` : la CIBLE reconnaît
//         un renforcement à « réception connue, sans clé » et la SOURCE à une invitation qui porte `replaces` (le webhook remplacé). Moteur :
//         `logic/reinforce.js` (`renfState`, `graceOpen`, `startRenf`, `finishRenf`, `canRevert`, `revertedNote`, `unsignedHooks`) ; note du
//         journal `renf` (`{ at }` en attente, `{ at, done }` fini) ; `checkSigned(..., { grace })` tolère les envois SANS signature (jamais
//         une mauvaise signature, jamais une ligne `fin`) tant que la première livraison signée n'est pas vue, 7 jours au plus (`GRACE_S`) ;
//         `unpack` finit le renforcement à la première livraison signée. SOURCE : `startReinforcement`, `canReinforce`, `controlResend`,
//         `approveReply` remplace le webhook (`replaces`, sans avis de fin, événement `reinforce` au lieu de `join`). CIBLE : `relinkReception`
//         démarre l'attente, `revertReinforcement` (« Revenir à l'ancien fonctionnement », retire clé publique, sceau et attente),
//         `isUnsignedReception`. Délai passé : les envois sans signature sont refusés comme avant (la carte dit « Renforcement interrompu »).
// 4.5.0 (12 novembre 2026, syncPlus 0.21.1, demande du porteur : « si le type Blob existe il faut qu'il transite sans souci », puis, sur la carte
//         « Choisir comment une colonne Blob arrive dans la CIBLE » : « Ne pas envoyer les Blob ») : mineure, rien n'est ajouté au port ni aux
//         tables, `CODE_FORMAT` inchangé, texte des formules de `Synchro` inchangé. **Constat** (Grist 1.7, vérifié) : aucune API n'écrit d'octets dans
//         une colonne Blob (texte, liste ou `['B', …]` refusés ; seule une formule Python en fabrique), la CIBLE ne peut donc pas recevoir un Blob
//         fidèlement. **Défaut corrigé** : un export qui portait une colonne d'un type que `SENT_TYPE` ne connaît pas (Blob, rang, identifiant
//         de ligne), cochée d'emblée, rendait l'invitation illisible chez la CIBLE (`codeInvalid`, sans explication). Maintenant `sentType`
//         (`logic/exports.js`) dit sous quel type une colonne part : Référence et liste de références en texte (comme avant), `PositionNumber`
//         en `Numeric`, `Id` en `Int`, ou `null` (Blob et tout type inconnu : la colonne ne part pas et n'est pas proposée) ; `unsentColumns`
//         les liste pour que l'hôte le dise (`send.columns.unsent`). `SENT_TYPE` passe de `codes.js` à `common.js`. Un export d'avant qui
//         envoyait un Blob est signalé par l'écart habituel (`exportDrift`), « Modifier » le retire.
// 4.6.0 (12 novembre 2026, syncPlus 0.22.0, demande du porteur : « boîte des changements de structure côté CIBLE, réglage appliquer
//         automatiquement / me demander à l'installation, désactivé par défaut ») : mineure, rien n'est ajouté au port ni aux tables,
//         `CODE_FORMAT` inchangé, texte des formules de `Synchro` inchangé. Une réception **demande** (`ask: true` dans la note du journal,
//         `optionsNote`) ou applique tout seule ; **une note sans `ask` applique** (réceptions d'avant, et `createReception` du moteur, donc GFS,
//         n'ont pas changé). Quand elle demande : une colonne ajoutée à l'export n'est ni créée ni recopiée (`freshColumns`, `held` de
//         `receivedColumns`) ; ses valeurs restent dans le journal. `approveStructure(journal, { auto })` (`target/loop.js`) la crée puis la
//         remplit depuis la dernière version de chaque clé (`backfillActions`, `logic/structure.js`, seulement les cellules vides) et, avec
//         `auto`, lève `ask`. Les autres changements ne se décident pas ici et sont seulement dits (`structureChanges` : `gone` colonne que la
//         SOURCE n'envoie plus, `retyped` type changé pour une colonne créée par le widget), acquittés dans `ack`. `tableResult` rend
//         `structure`. Ni Échange ni lien public.
// 4.7.0 (12 novembre 2026, syncPlus 0.23.0, demande du porteur : « si je choisis une table existante déjà avec les bonnes colonnes ou mapping avec
//         déjà de la data, que se passe-t-il ? » puis « aperçu, contrôle de type, alerte ») : mineure, rien n'est ajouté au port ni aux tables,
//         `CODE_FORMAT` et texte des formules de `Synchro` inchangés. `logic/adopt.js` : `typeFit` / `fitIssues` (le type de chaque colonne d'ici qui
//         reçoit une colonne envoyée : 'same', 'fine', 'risky', 'bad'), `adoptionStep` / `adoptionPreview`. Une réception qui demande l'accord (`ask`)
//         note `adopt: true` dans l'entrée d'une destination qui existait avant elle (`receptionNote` ; `offerDialog` pour une table rangée plus
//         tard) ; sa première recopie n'écrit rien (`copyTable`, 'hold') quand elle ajouterait ou modifierait des lignes dans une table qui a déjà
//         des lignes : `structure.adoption` du résultat de la table dit ce qui arriverait (lignes ajoutées, rattachées par `match`, valeurs remplacées,
//         cellules remplies, lignes qui ne bougent pas, exemples). `approveStructure` écrit et note `adopted: true` (`noted` de `saveEntries`) ; une
//         réception qui applique seule, ou une destination vide, note `adopted` à la première recopie sans rien retenir. Une note sans `ask` ou sans
//         `adopt` ne change pas (réceptions d'avant, GFS qui ne passe pas `options.ask`). `planConsolidation` rend aussi `attached`, `sameValue` est exportée.
// 4.8.0 (12 novembre 2026, syncPlus 0.24.0, point 5 de la liste du porteur : « colonnes non envoyées, renommages, type changé ») : mineure, rien n'est
//         ajouté au port ni aux tables, `CODE_FORMAT` et texte des formules de `Synchro` inchangés. `logic/new-columns.js` (`knownColumns`, `newColumns`,
//         `exportFlags`, `widenedSelection`) et `source/new-columns.js` (`baselineNewColumns`, `pendingColumns`, `sendNewColumns`, `dismissNewColumns`,
//         `autoSendNewColumns`) : l'entrée d'un export dans la note SOURCE garde `known` (les colonnes envoyables de chaque table à l'enregistrement ou au
//         dernier choix) et `autoCols` ; une colonne ajoutée depuis, ni envoyée ni connue, est « nouvelle » (jamais pour un Échange). `saveChosenExport`
//         accepte `autoCols` et écrit `known`. `logic/exports.js` : `driftDetails` dit chaque colonne changée (`gone` avec `to` quand un seul pendant du
//         même type reste, `retyped` avec `was`/`now`, `shown`) ; `exportDrift` ne change pas.
// 4.9.0 (12 novembre 2026, syncPlus 0.25.0, point 6 de la liste du porteur : « valeurs par défaut et formules de déclenchement, mêmes garde-fous que les
//         formules ») : mineure, rien n'est ajouté au port ni aux tables, `CODE_FORMAT` et texte des formules de `Synchro` inchangés. Dans la description
//         signée des colonnes, `fd` (formule par défaut d'une colonne de données : formule de déclenchement « sur les nouvelles lignes », `recalcWhen` 0
//         sans colonne suivie, `sourceDefault` de `logic/column-formulas.js`) à côté de `fx`, sous la même case et le même plafond de longueur. Une formule qui se
//         recalcule quand une colonne change, ou à toute modification, ne part pas. `planFormulas` rend `kind` ('column' ou 'default') sur chaque ligne et pose une
//         formule par défaut par `ModifyColumn { isFormula: false, formula, recalcWhen: 0 }` (colonne créée par le widget seulement, jamais une colonne de formule
//         ici : `formulaHere`), sous les mêmes garde-fous et le même clic de propriétaire (`restyle(journal, { formulas: true })`).
// 4.10.0 (12 novembre 2026, syncPlus 0.26.0, point 7 de la liste du porteur : « option SOURCE pour l'ordre, les colonnes cachées et les vues ») : mineure, rien n'est
//         ajouté au port ni aux tables, `CODE_FORMAT` et texte des formules de `Synchro` inchangés. `logic/layout.js` (`modelSection`, `withLayout`, `layoutSent`,
//         `planLayout`, `isPos`) et `target/layout.js` (`layoutColumns`) : dans la description signée des colonnes, `pos` (rang de la colonne parmi les colonnes
//         envoyées et montrées par la page de la table, -1 si la page la cache) quand l'export l'envoie (`saveChosenExport({ …, layout })`, case décochée d'emblée,
//         jamais en Échange). La SOURCE le lit dans la première section de type tableau d'une page de la table (`_grist_Views_section`, `_grist_Views_section_field`)
//         et le tient à jour (`refreshOptions`, sans renvoi de ligne). La CIBLE (`planLayout`) ne touche que les colonnes créées par le widget : une fois chacune
//         (`laid` dans l'entrée de la note), puis sur `restyle(journal, { layout: true })` ; elle retire le champ d'une colonne cachée et répartit les places des champs
//         entre les colonnes montrées (les autres champs ne bougent pas). Seuls les champs de la section de page sont écrits : jamais une donnée, un droit, un tri
//         ni un filtre. `sentElements` rend 'layout'.
// 4.11.0 (12 novembre 2026, syncPlus 0.27.0, demande du porteur : « lorsqu'il y a des références dans les tables envoyées, côté source, peut-on l'indiquer ?
//         et demander si l'user veut envoyer le contenu uniquement en valeur ou ajouter la table/colonnes utilisées pour conserver les relations ?
//         et dans ce cas il faut que côté cible on refasse les références fonctionnelles », puis choix « Par colonne, tables ajoutées ») : le
//         lien d'une colonne Référence ou Liste de références se décide colonne par colonne. SOURCE : `linkOffers` (`logic/links.js`) dit pour
//         chaque colonne cochée ce qu'elle vise, si le lien est possible et quelles tables s'ajoutent à l'export (avec leur seule colonne
//         affichée, en cascade) ; `saveChosenExport({ links })` accepte maintenant un ensemble de `refKey` (« Table.Colonne ») en plus de `true`
//         (toutes les Références, comme avant : `linkTables(tables, true)` ne touche pas aux listes) ; une Liste de références qui garde son lien
//         porte `list: true` à côté de `link` dans la description signée des colonnes (le lot porte la liste des clés des lignes visées dans
//         `Synchro_Cle_<colonne>` : le texte des formules de `Synchro` ne change pas, `getattr(r, id).id_sync` rend la liste pour une Liste de
//         références). CIBLE : une colonne texte créée par le moteur devient une Liste de références comme une Référence (`RefList:<table>`),
//         ses cellules reçoivent `['L', numéros…]` et sont complétées à l'arrivée d'une ligne visée (`fillLinks`) ; une colonne restée du texte
//         parce qu'elle était remplie quand le lien est arrivé est dite dans le résultat de la table (`relinkable`) et `relink(journal)`
//         (nouveau, sur le clic d'un propriétaire) la convertit et reprend le lien de la SOURCE dans ses cellules. Ni port, ni nom de table, ni
//         `CODE_FORMAT`, ni texte des formules de `Synchro` ne changent. Une CIBLE d'avant la 4.11 qui reçoit une colonne `list` en ferait une
//         Référence simple : à ne pas mélanger après la publication (relever `CODE_FORMAT` alors).
// 4.12.0 (13 novembre 2026) : le nom du document de la SOURCE peut se lire dans l'adresse de la page collée par la personne (un widget ne
//         peut pas lire le sien, voir 2.2.0). `parsePageAddress` et `docNameFrom` (`logic/codes.js`, purs) lisent l'équipe, l'identifiant et le
//         nom que Grist écrit dans l'adresse (« Donnees-Ministere-2026-v2 » : sans accent ni ponctuation) et refusent une adresse d'une autre
//         instance ou d'un autre document (`otherSite`, `otherDoc`) : seul le nom en sort, jamais l'adresse. Ni port, ni nom de table, ni
//         `CODE_FORMAT` ne changent ; l'hôte qui a un champ « nom du document » peut s'en servir avant `rememberDocName`.
// 5.0.0 (13 novembre 2026, syncPlus 0.28.2, avant la sortie de la Bêta ; demande du porteur : relever `CODE_FORMAT` comme la 4.11.0 l'annonçait) :
//         **majeure**, par la règle ci-dessus (un format de code que le moteur d'avant ne lit plus). `CODE_FORMAT` passe de 1 à 2
//         (`logic/codes.js`, désormais exporté) : une CIBLE d'avant la 4.11.0 (Liste de références, `list` dans la description des colonnes)
//         recevrait sinon une invitation d'une SOURCE plus récente et ferait d'une colonne `list` une Référence simple sans rien dire. Elle
//         refuse maintenant le code : `codeNewer`, avec la version du code et la sienne (essayé contre le vrai lecteur de la 4.11.0 : refus des deux
//         côtés, invitation et réponse). **Aucun champ des codes n'a changé de sens ni de contenu** : seule la valeur de `f` change. Les codes de
//         forme 1 déjà faits (invitation en attente, réponse) sont lus tels quels ; une SOURCE d'avant refuse la réponse d'une CIBLE à la forme 2
//         (même message, du côté de la SOURCE). Texte `error.codeNewer` (fr et en) : dit que le widget de ce document est en retard, que rien
//         n'est à refaire dans l'autre document, et de recharger la page. Ni port, ni nom de table, ni texte des formules de `Synchro` ne
//         changent. Une liaison déjà branchée n'est pas concernée (les lots se lisent dans le journal, pas dans un code) : deux documents qui
//         veulent se lier de nouveau doivent avoir la même version du widget, comme toujours.
// 5.0.1 (16 novembre 2026, syncPlus 0.30.2, refonte de fond avant la Bêta) : correctif, sans ajout ni retrait. Douze fonctions du moteur
//         (et quatre de l'écran) passaient les seuils de l'outil d'audit (81 lignes ou plus, complexité au-dessus de 15) : elles sont découpées sans rien changer à ce
//         qu'elles rendent : `exportSchema`, `parsePageAddress`, `schemaText`, `planNotes`, `planFormulas`, `planRules`, `fillable`,
//         `prepareColumns`, `copyTable` et le lecteur de règles de mise en forme (`tokens`, `parser`, `body` de `logic/rules.js`).
//         Deux exports qu'aucun code n'appelait (`deadLink`, `linkable`) sont retirés. Les plans d'une destination (mise en page,
//         descriptions, formules, formats) partagent `destContext` (`logic/schema.js`) au lieu de six copies des mêmes lignes. Port, tables,
//         codes et texte des formules inchangés (`formulas-golden`) ; comparaison avant/après sur des centaines de milliers de cas
//         (`exportSchema` 40 000, règles 200 000).
// 5.0.2 (17 novembre 2026, syncPlus 0.30.4, audit de sécurité avant la Bêta) : correctif, sans ajout ni retrait au port, aux tables ni aux
//         codes (`CODE_FORMAT` 2, texte des formules de `Synchro` inchangé : `formulas-golden`). **La lecture d'une formule reçue refuse plus**
//         (`logic/column-formulas.js`, `formulaProblems`) : tout nom qui commence par un tiret bas (les modules permis gardent `os` et `sys` sous
//         un nom privé : `random._os`), tout caractère hors ASCII hors des textes et les mots lus après la normalisation NFKC de Python (un
//         `eval` en pleine largeur), `operator`, `attrgetter`, `Formatter`, `get_field`, `REQUEST` (la fonction de Grist qui appelle une adresse
//         du réseau), `grist`, `docmodel`, `engine`, `while`, `sleep`, `exit` ; `string` et `fractions` quittent `SAFE_MODULES` ; toute table d'ici
//         qui n'est pas dans l'export est refusée quelle que soit la façon de la lire (`schemaFrom` rend `everyTableId`, résumés compris ; un
//         port qui bâtit son schéma sans lui retombe sur `tableIds`). Les noms, adresses électroniques, identifiants de documents, libellés de
//         colonnes et noms de fichiers que les codes et les listes de fichiers portent sont nettoyés comme les autres textes dits par l'autre
//         document (`cleanLabel`, `safeName`). Un hôte qui montre les objections d'une formule reçoit des noms de plus dans `unsafe` (un nom privé,
//         un caractère hors ASCII) ; rien d'autre ne change pour lui.
export const ENGINE_VERSION = '5.0.2';

// Version de l'application qui fait tourner le moteur : elle est écrite dans les codes d'invitation
// et de réponse (qui s'en servent pour avertir d'un code plus ancien ou plus récent, voir
// versionNote). Donnée par startEngine ; à défaut, celle du moteur.
let appVersionValue = ENGINE_VERSION;
export const setAppVersion = (version) => {
  if (version !== undefined && (typeof version !== 'string' || !/^[0-9A-Za-z.+_-]{1,32}$/.test(version))) throw new Error(`version invalide : ${JSON.stringify(version)}`);
  appVersionValue = version || ENGINE_VERSION;
};
export const appVersion = () => appVersionValue;
