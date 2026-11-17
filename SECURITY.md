# Sécurité

Ce document s'adresse à la personne qui audite le widget. Il dit ce qui sort de quel document,
par quel canal, avec quels droits, ce que le widget refuse de faire, et les risques acceptés.
Les affirmations marquées « vérifié » ont été essayées dans un vrai Grist (test d'intégration,
`tests/e2e/run.mjs`, ou essai dédié).

## Signaler une faille

Ne pas ouvrir de ticket public. Utiliser la VDP de l'État
(https://vdp.numerique.gouv.fr/p/Send-a-report) ou contacter Grist Factory (grist-factory.fr).

## En bref

- Aucun serveur, aucune dépendance, aucune donnée hors de l'instance Grist : le transport est le
  webhook natif de Grist, d'un document à l'autre de la même instance.
- Une seule table technique dans la SOURCE (`Synchro`), qui ne porte que les colonnes cochées des
  exports. Un webhook par destinataire, filtré sur son export.
- Chaque réception a sa propre clé d'écriture (un formulaire publié sur sa propre page), qui ne
  peut qu'ajouter des lignes à son journal. La CIBLE contrôle ce qui y arrive avant de recopier.
- Les codes échangés sont des **identifiants** : ils se transmettent comme un mot de passe. Une
  invitation vaut 7 jours et porte toujours un secret.
- Le document qui recevra est lu **chez Grist** (nom, dossier, équipe) à l'approbation, puis
  revérifié toutes les heures ; un code de contrôle court se compare de vive voix.
- Les envois sont **signés** (HMAC-SHA256, une clé par destinataire, tirée d'un échange de clés
  publiques : aucune clé secrète ne voyage dans les codes), et ce que la CIBLE en déplie est
  **scellé** avec la même clé : la clé d'écriture d'une réception ne suffit plus pour y faire
  recopier des données, et un destinataire ne peut pas signer pour un autre.
- Règles d'accès posées par le widget : `Synchro` réservée aux propriétaires de la SOURCE, journaux
  de la CIBLE réservés à ses éditeurs (case cochée par défaut).
- Niveau **Renforcé**, au choix à l'invitation : code de contrôle à comparer obligatoirement, pas
  de lien public.
- Sur `grist.numerique.gouv.fr`, les webhooks sont **limités à l'instance** : aucun webhook ne peut
  faire sortir des données vers un autre serveur (voir « Chaîne d'approvisionnement »).

## Surface

- Page statique : HTML, CSS et modules JavaScript natifs, sans bibliothèque tierce, sans étape de
  build. Le seul script externe est `grist-plugin-api.js`, chargé depuis l'instance qui affiche le
  widget si elle est dans la liste de `js/config.js`, sinon depuis la première de la liste.
- Politique de sécurité du contenu (`index.html`) : `default-src 'none'` ; scripts du widget et
  `grist-plugin-api.js` des instances listées, rien d'autre de ces instances ; requêtes réseau vers le widget lui-même (textes `i18n/*.json`) et ces
  instances ; styles et images du widget seulement ; aucun script ni style en ligne ;
  `base-uri` et `form-action` à `'none'` ; pas de référent envoyé.
- Toute requête réseau passe par `gristFetch` (`js/grist.js`), qui refuse une adresse hors des
  instances listées et n'envoie jamais de cookie (`credentials: 'omit'`). Les envois directs à une
  adresse d'écriture (test du lien, ligne « fin », morceaux de fichiers) ne partent que vers
  l'instance du document, comme le webhook.
- Aucun texte venu d'un document ou d'un code collé n'est inséré comme HTML : l'interface est
  construite avec des nœuds texte (`js/ui.js`, fonction `el`). Aucun `innerHTML`, `eval` ou
  `Function`. Les classes CSS ne viennent que du code (l'état d'une ligne d'historique est l'un de
  trois mots connus).
- Liens vers les documents (0.13.5) : la ligne d'un destinataire (SOURCE) et la carte d'une réception
  (CIBLE) montrent le document de l'autre côté en lien (`docLink`, `js/ui.js`), dans un nouvel onglet
  (`target="_blank"`, `rel="noopener noreferrer"`). L'adresse n'est jamais celle d'un code : `docUrl`
  (`js/engine/logic/codes.js`) la refait de l'instance de **ce** document (https, ou http sur `localhost`
  pour un Grist d'essai), d'une équipe et d'un identifiant qui n'ont que la forme `[A-Za-z0-9_-]`, sous
  `/o/<équipe>/<identifiant>/<nom>` (la forme que Grist écrit ; le nom n'est que cosmétique). Un lien ne quitte donc pas l'instance, et le seul lien externe du widget
  reste celui des crédits.
- Stockage local du navigateur : langue, thème, date de la dernière visite par document CIBLE
  (historique), identifiant tiré au hasard pour ce navigateur (renvois). Aucune donnée du document.
- Accès demandé à Grist : **complet**. Le widget crée des tables et des colonnes, lit les
  métadonnées, écrit dans les tables de destination et gère les webhooks (propriétaires).

## Requêtes réseau

Toutes vont vers l'instance Grist qui affiche le widget (ou une autre instance de la liste, jamais
ailleurs).

| Requête | Quand | Authentification |
|---|---|---|
| `GET <instance>/grist-plugin-api.js` | au démarrage | aucune |
| `GET/POST/PATCH/DELETE <document>/webhooks…` | onglet Envoyer et Échange : lister, créer, renommer, suspendre, supprimer un webhook, vider la file ; page ouverte par un propriétaire, toutes les 10 s (60 s onglet caché) : état des envois | jeton court du document (`getAccessToken`) en paramètre `auth=` ; Grist réserve ces appels aux propriétaires |
| `GET <document>/sql?q=select …` | lectures légères répétées (colonnes de `Synchro`, ligne de test d'un journal) | jeton court aux droits de la personne (un jeton en lecture seule y est refusé dès que le document a des règles d'accès, vérifié) ; Grist le réserve à qui peut lire tout le document, sinon le widget lit la table entière |
| `GET <document>/compare?left=<état>&right=HEAD&maxRows=1` | onglet Recevoir, toutes les 10 s page ouverte : quelles tables ont changé depuis le coup d'œil précédent (seuls leurs noms servent ; Grist renvoie aussi au plus une valeur par colonne changée, que le widget ignore) | jeton court aux droits de la personne, comme `/sql` ; Grist le réserve à qui peut lire tout le document, sinon le widget relit comme avant |
| `POST <instance>/api/s/<clé>/tables/<journal>/records?flat=1` | bouton « Tester le lien » : une ligne marquée d'un nombre au hasard ; SOURCE, page ouverte par un propriétaire : morceaux des pièces jointes (adresse lue dans le webhook du destinataire), ligne « fin » | aucune (clé du formulaire) |
| `GET <document SOURCE>/attachments/<n°>/download` | SOURCE, page ouverte par un propriétaire : contenu d'un fichier d'une colonne Pièces jointes cochée, à envoyer | jeton court en lecture seule |
| `POST <document CIBLE>/attachments` | CIBLE, page ouverte par un éditeur : dépôt d'un fichier reçu en entier et vérifié | jeton court du document |
| `GET <instance>[/o/<équipe>]/api/s/<clé>` | SOURCE : vérification d'une réponse, puis de chaque destinataire au plus une fois par heure, page ouverte par un propriétaire ; CIBLE : lecture d'une invitation d'Échange | aucune (requête anonyme) ; Grist rend le nom, l'identifiant, le dossier et l'équipe du document de la clé |
| `GET <document SOURCE>` | onglet Envoyer : le document est-il lisible par lien public, et avec quel rôle ? | aucune (requête anonyme) |
| `GET <document SOURCE>/tables/Synchro/records?filter=…` | CIBLE en mode lien public, page ouverte : les lignes `empreinte`, puis `complet` si elles ont changé | aucune (requête anonyme) |

Les écritures REST portent l'en-tête `X-Requested-With`, exigé par Grist contre les requêtes
forgées. Le reste passe par l'API des widgets (`grist.docApi`), avec les droits de la personne.

## Flux de données

- **SOURCE vers CIBLE** : par les webhooks natifs de Grist, côté serveur, même page fermée. Un
  webhook envoie toutes les colonnes de la table qu'il surveille, sans appliquer les règles
  d'accès (comportement de Grist) : c'est pourquoi il surveille la table technique `Synchro`, où
  une formule calcule, dans `Synchro_Lot`, les **colonnes cochées** de l'export en un bloc JSON.
  Les autres colonnes ne sortent pas. Par table d'un export, `Synchro` a une ligne `cles` (seaux
  d'empreintes des clés `id_sync`, pour les suppressions), une ligne `lot` (lignes modifiées depuis
  5 secondes, ou demandées en renvoi), et pour un export public une ligne `complet` et sa ligne
  `empreinte`.
- **Isolation entre exports** : chaque webhook a une **condition** Grist (1.7.11 et plus),
  `rec.Synchro_Export == "<export>" and rec.Synchro_Type in ("cles", "lot")`. Le widget n'écrit
  cette condition que pour un identifiant de 16 chiffres hexadécimaux, relit celle que Grist a
  enregistrée et supprime le webhook si elle manque ou diffère (instance trop ancienne), et signale
  « Webhook sans filtre » tout webhook sur `Synchro` dont la condition n'a pas exactement cette
  forme. Vérifié : un webhook ne reçoit pas les lignes d'un autre export, et un destinataire
  révoqué ne reçoit plus rien alors qu'un autre continue.
- **Échange** (synchro dans les deux sens, deux documents qui ont chacun le widget) : chaque côté
  envoie par son propre webhook vers le journal de l'autre. Les deux côtés doivent être tenus par
  un propriétaire (création de webhook). Chaque document n'écrit, dans ses tables, que les
  colonnes qu'il envoie lui-même pour ces tables : une colonne de plus annoncée par l'autre côté,
  ou renommée vers une autre colonne, est ignorée. L'adresse de retour (clé d'écriture du journal
  du document qui invite) voyage dans le code d'invitation et n'est notée nulle part ailleurs que
  dans le webhook de l'autre côté. Les règles du document qui administre (accepter, refuser, à
  valider) sont notées dans sa note d'exports, jamais dans un journal : un participant ne peut pas
  faire passer un changement pour accepté. Un changement à valider n'est écrit qu'au clic sur
  **Accepter** ; une ligne de journal forgée marquée « refusée » ne change que l'affichage. Une
  invitation d'Échange qui reprend l'identifiant d'un export de ce document est refusée (elle
  remplacerait cet export et couperait ses destinataires).
- **Pièces jointes** : une colonne Pièces jointes ne part que cochée. Le lot ne porte que la liste
  de ses fichiers (empreinte, nom, taille). Le contenu ne passe pas par le webhook : le widget
  SOURCE, page ouverte par un propriétaire, télécharge chaque fichier cité par une ligne de
  l'export (filtre compris) avec son jeton, et le poste à l'adresse du webhook de chaque
  destinataire (la clé de son formulaire), en morceaux. La CIBLE ne dépose un fichier qu'arrivé en
  entier, de la taille annoncée et dont le SHA-1 est l'empreinte annoncée (25 Mo au plus, 50
  morceaux, nom sans chemin ni caractère de contrôle) ; un morceau illisible ou un fichier altéré
  est effacé et compté parmi les « Arrivées suspectes ». Les morceaux ne sont pas signés, les
  versions si : un fichier n'est déposé que si une version reçue le cite (ou une cellule qui
  l'attend encore) ; sinon il attend la sienne un jour au plus, puis est effacé (vérifié). Les
  morceaux en attente (envois en cours, fichiers non cités) sont bornés à 50 Mo par journal : au-delà,
  les plus anciens sont effacés, et un envoi incomplet en trop compte parmi les « Arrivées
  suspectes ». Le nom d'un fichier perd aussi ses caractères invisibles et de sens d'écriture
  (« facture\u202Efdp.exe »). Pas de fichiers par lien public. **Dans un Échange (0.14)**, les fichiers vont
  aussi du participant vers A, par le même mécanisme et les mêmes contrôles : l'export de retour garde les colonnes
  Pièces jointes que A a cochées, et rien d'autre ne passe. Un fichier n'est toujours déposé que si une version
  **signée et scellée** le cite. Pour ne pas renvoyer à un partenaire ce qu'il vient d'envoyer, le widget note
  (`o` dans le suivi `fichiers`) les empreintes citées par ses versions déjà vérifiées : un participant ne peut que
  se priver lui-même d'un fichier. En Échange, une version dont un fichier n'est pas encore arrivé n'est pas
  recopiée (elle attend, gardée par la purge), pour qu'une cellule incomplète ne reparte pas comme la plus récente.
- **`Synchro` réservée aux propriétaires** : ses formules lisent les tables sans les règles
  d'accès, et elle porte les clés de signature des destinataires. À l'ouverture de l'onglet Envoyer par un
  propriétaire, le widget pose des règles de mémo « Synchro : réservée aux propriétaires », avant
  les autres : un lecteur ne la voit pas, un éditeur ne voit ni ne modifie ses lignes. **Depuis la 0.19, ces règles sont
  posées avant la première donnée d'un export** (`protectSync`, `js/engine/acl.js`) : « Nouvel export » crée la table `Synchro`
  vide, pose les règles même si un assistant est ouvert, et Grist recharge le document ; l'assistant se rouvre seul (une
  préférence qui ne garde qu'une heure, `askWizard`). Avant, la table naissait avec le premier export et ses règles à la
  fermeture du premier assistant : pendant ce temps, une colonne cachée aux lecteurs par une règle de la personne se lisait
  dans le lot (vérifié en 0.18, sonde `tests/e2e/tools/probe-gaps.mjs`, 200 avant, 403 après). Un Échange reçu passe par la
  même étape avant d'écrire dans `Synchro` (`syncUnprotected`, fenêtre « Protéger ce document »). **Sans Échange, la règle est
  un refus net** (`user.Access != OWNER` → `-CRUD`, sans condition de ligne) : Grist ne vide les options d'une colonne que si
  la lecture est refusée sans condition, et une règle de lignes laissait donc lire la note de la SOURCE (fiches des destinataires,
  clé privée d'une invitation en attente) aux éditeurs par `_grist_Tables_column`. Seule exception, pour la recopie d'un Échange par
  un éditeur : les lignes `echange` et `lot` des exports en Échange, sans leur contenu, et leur colonne `Synchro_Renvoi` ; les
  règles d'avant restent alors, et la note est lisible par les éditeurs de ce document (risque accepté, voir plus bas). Un éditeur
  ne voit donc plus les cartes des exports. **Limite** : par défaut, Grist laisse les éditeurs modifier la
  structure du document, donc les formules de `Synchro` (ce qui part) et la description de ses
  colonnes ; une règle d'accès n'y peut rien. Il faut décocher « Permettre aux éditeurs de modifier
  la structure » ; en Renforcé, la carte de l'export le demande tant que ce n'est pas fait. Changer
  une règle recharge le document (une fois) ; le widget ne le fait jamais pendant un assistant
  ouvert, et ne touche jamais aux règles des autres (vérifié : l'ordre est gardé, rien n'est
  reposé au chargement suivant).
- **Mode lien public** : la SOURCE est partagée en lecture « toute personne ayant le lien », par
  son propriétaire. Le widget pose d'abord des règles d'accès, de mémo « Synchro : lecture limitée
  aux exports publics », placées avant les autres, pour `user.Access == VIEWER` : lecture refusée
  sur tout le document sauf, dans `Synchro`, les lignes `complet` et `empreinte` des exports
  publics, et sans la colonne `Synchro_Export`, dont les options portent la note de la SOURCE
  (sinon lisible par tous, vérifié). Conséquences : tout lecteur du document (pas seulement le lien
  public) ne voit plus que ces lignes, et les données des exports publics sont publiques. Les noms
  des tables des exports restent lisibles dans les formules de `Synchro`. Vérifié : sans
  identifiant, les tables d'origine répondent 403 et `Synchro` ne montre que les lignes de l'export
  public. La note est dans les **options** de la colonne, que Grist vide pour qui ne la lit pas, y
  compris dans ses tables de métadonnées (0.18, moteur 3.0.0 ; avant, dans la description, que
  Grist laissait lire : voir « Ce que voit un lecteur ou le lien public », dans « Qui peut
  quoi »). L'assistant liste en rouge les colonnes rendues
  publiques, refuse une table dont une règle d'accès (d'autrui) cache des lignes ou des colonnes
  (les formules de `Synchro` liraient sans elle) ; une règle sur toutes les tables compte, comme
  celle d'une table dont une colonne Référence de l'export affiche le texte. Ce contrôle est refait
  à chaque modification d'un export public (refusée s'il échoue) et à chaque affichage de sa carte
  (une règle posée depuis y est signalée). La carte alerte aussi si le lien public donne plus que
  la lecture. Un export Renforcé n'a pas de lien public.

## Codes d'invitation et de réponse

Ils sont faits pour être copiés dans un courriel : ce sont des **identifiants**, à transmettre à
la seule personne concernée. Sous chaque code, le widget le rappelle : ne le coller ni dans une
IA, ni dans un ticket, ni dans un salon de discussion.

- **Invitation** : identifiants de l'invitation et de l'export, nom de l'export, instance,
  e-mail de la personne qui l'a créée et identifiant du document SOURCE (affichés à la CIBLE avant
  d'accepter, et utiles pour refuser une boucle), tables et colonnes envoyées, un secret aléatoire
  de 128 bits, la date d'expiration, le niveau (Renforcé ou non) et la **clé publique** d'une paire
  tirée pour cette invitation (ECDH P-256). En mode lien public : l'adresse REST du document, réécrite et contrôlée
  (même instance que la CIBLE). En Échange : l'adresse d'écriture du journal de retour, c'est-à-dire
  **une clé d'écriture**.
- **Réponse** : adresse d'écriture du journal de la CIBLE (**une clé d'écriture**), fiche du
  destinataire (e-mail calculé par le serveur Grist de la CIBLE, `user.Email`, identifiant du
  document, équipe, date), le secret, la clé publique d'une paire tirée par la CIBLE, et en
  Échange les tables de retour.
- **Aucune clé secrète dans les codes** : de sa clé privée et de la clé publique de l'autre côté,
  chacun tire le même secret (ECDH P-256), puis deux clés de 128 bits propres à cette invitation
  (HKDF-SHA256 sur l'export et l'invitation) : l'une signe les envois de la SOURCE vers ce
  destinataire, l'autre l'envoi de retour d'un Échange. Qui lit les deux codes (un fil de
  courriel) n'en tire rien (vérifié). La clé privée de la SOURCE reste dans la note de `Synchro`
  jusqu'à l'approbation ; celle de la CIBLE n'est gardée nulle part. Un code d'avant la 0.10
  (clé de signature de l'export en clair) est refusé : l'invitation est à refaire.
- La SOURCE ne garde que l'empreinte SHA-256 du secret ; la CIBLE garde le secret dans la note de
  son journal, utile seulement tant que l'invitation est en attente. Le secret est obligatoire
  depuis la 0.8 ; une invitation en attente créée avant, sans secret, est encore acceptée une fois.
- **Expiration** : une invitation vaut 7 jours (date dans le code et sur la carte). Expirée, la
  CIBLE la refuse et la SOURCE refuse sa réponse ; « Refaire le code » en produit une nouvelle,
  avec un nouveau secret.
- **Document vérifié par Grist** : l'e-mail de la fiche est déclaratif (il voyage dans le code
  collé). Le document, son dossier et son équipe, eux, sont lus chez Grist à partir de la clé de
  la réponse (`GET /api/s/<clé>`, anonyme, vérifié) et comparés à l'identifiant de la fiche : refus
  s'ils diffèrent, avertissement pour un espace personnel (n'importe qui peut en créer un). La
  CIBLE fait de même pour l'adresse de retour d'un Échange. La SOURCE revérifie chaque webhook au
  plus une fois par heure, page ouverte : un co-propriétaire peut en changer l'adresse dans les
  réglages de Grist ; la carte signale un autre document que celui de la fiche, et une adresse qui
  n'est plus celle d'un formulaire de cette instance. Ce contrôle protège de l'erreur, pas d'un
  co-propriétaire décidé, qui peut aussi réécrire la fiche (la note de la SOURCE, depuis la 0.19 ; le mémo du webhook n'est plus qu'un jeton).
- **Code de contrôle** : 6 caractères tirés de SHA-256(clé de partage, secret, niveau, clés
  publiques de l'invitation et de la réponse), montrés des deux côtés (sans 0, 1, I, L, O). La clé
  de partage est tirée par Grist : le reste de l'adresse (le préfixe d'équipe, que Grist ne
  contrôle pas pour une clé de partage) n'entre pas dans le calcul, sinon un intermédiaire
  pourrait le faire varier jusqu'à retomber sur le même code. Ils ne coïncident que si la réponse
  vient de qui a reçu l'invitation, désigne ce formulaire, et si personne n'a remplacé une clé
  publique ni retiré la sécurité renforcée en route (vérifié par les tests) : à comparer par
  téléphone, ce qui ferme le cas d'un attaquant dans la même équipe ou placé entre les deux. Conseillé en Standard ; en Renforcé, une case « J'ai comparé » est exigée avant
  d'approuver (et, en Échange, côté CIBLE avant de répondre).
- **Document de la SOURCE : nom et équipe (0.13.5)** : l'invitation porte `from.team` (l'équipe du document,
  pour refaire son adresse) et `from.docName`, le nom que la personne a saisi (un widget ne peut pas lire le
  nom de son document : `getDocName` rend l'identifiant, la fiche REST est refusée au jeton ; vérifié sur
  Grist 1.7). Ce nom est un **dire** comme l'e-mail de la fiche : montré en texte seul (jamais en HTML),
  nettoyé à la lecture (`cleanLabel` : caractères de contrôle et de sens d'écriture ôtés, 200 caractères),
  et l'infobulle du lien le dit (« non vérifié »). Il n'entre dans aucune décision, ni dans le code de
  contrôle. En Échange, le nom et l'équipe lus chez Grist à partir de la clé de retour l'emportent et sont
  dits vérifiés. Côté SOURCE, le nom du document du destinataire est celui que Grist donne pour la clé de
  sa réponse, et le lien se refait de l'identifiant et de l'équipe de la fiche : sans lien quand le contrôle
  horaire a vu un autre document ou une adresse qui n'est plus celle d'un formulaire. Les noms lus chez
  Grist sont nettoyés de même (`readShare`). Un code d'avant (sans `team`) n'a pas de lien. **Adresse de page
  collée (0.28.1)** : la personne peut coller l'adresse de la page à la place du nom (`docNameFrom`,
  `parsePageAddress`, `logic/codes.js`) ; le nom est lu dans le chemin (`/<identifiant>/<nom>`), seulement si
  l'instance (origine exacte) et l'identifiant (préfixe d'au moins 12 caractères) sont ceux de ce document,
  sinon rien n'est lu et l'avis le dit. Seul le nom en sort (nettoyé comme tout nom) : l'adresse n'est ni
  gardée ni envoyée, aucune requête n'est faite avec elle. Le nom lu reste un dire, au même titre qu'un nom tapé.
- Contrôles à la lecture (`js/engine/logic/codes.js`) : préfixe et version, identifiants, secret,
  colonnes (noms Grist, types connus, 400 au plus), textes coupés à 200 caractères, adresses de la
  forme exacte `/api/s/<clé>/tables/<table>/records?flat=1` sur la **même instance**, sans
  identifiant dans l'adresse, réécrites avant usage. La réponse doit porter le secret d'une
  invitation en attente de ce document.
- Une nouvelle invitation pour un export déjà reçu (lien coupé, destinataire révoqué) ne reprend
  la réception qu'après confirmation, fiche affichée, et seulement si elle vient du même document
  dans le même mode.

### Canal entre onglets du même navigateur (0.15)

Quand une même personne a les deux documents ouverts dans deux onglets du même navigateur, l'invitation
et la réponse peuvent passer d'un widget à l'autre par un `BroadcastChannel` (`js/tab-link.js`),
sans copier-coller. Ce n'est qu'un transport de texte, côté écran (jamais dans le moteur) : ce qui
arrive est un code comme un code collé, jugé par le moteur de la même façon (document de la clé chez
Grist, code de contrôle, péremption, comparaison obligatoire en sécurité renforcée). Le lien du
formulaire reste à coller (Grist ne le donne pas à un widget). Vérifié dans un vrai Grist, deux
onglets du même navigateur (`ONLY_TABS=1`).

- **Qui l'entend** : les pages de la même origine que le widget, dans le même navigateur et le même
  profil (autre profil, autre navigateur, autre poste : rien, mesuré par GFS). Un GitHub Pages est une
  origine commune à tous les dépôts d'un compte : tout code de cette origine, ouvert là, peut entendre
  ce que le canal porte, dont le secret d'une invitation et l'adresse d'écriture d'une réponse. Même
  exposition qu'un code envoyé par courriel, sans copie dans une boîte aux lettres, mais devant plus
  de monde dans le navigateur. Un widget d'une autre origine n'entend rien.
- **Rien ne part ni ne s'écrit sans un geste** : l'invitation ne part que sur le bouton de la SOURCE ;
  la CIBLE ne montre qu'un avis (« Recevoir », « Ignorer ») et n'écrit rien avant. Un document en
  lecture seule, ou un autre onglet du document qui invite, n'en montre pas. La réponse repart d'elle-même
  seulement quand l'invitation est venue du canal ; la SOURCE la contrôle aussitôt, mais l'approbation
  reste un clic (et, en sécurité renforcée, la case « J'ai comparé »).
- **Le canal n'identifie personne** : le nom de l'export et du document annoncés ne servent qu'à
  l'affichage ; l'identité du document est celle que Grist dit de la clé (`shareInfo`), à la lecture
  de l'invitation puis à celle de la réponse. Un message forgé par une page de la même origine n'a pas
  plus de poids qu'un code collé : une réponse sans le secret de l'invitation ou qui désigne un autre
  document est refusée, et une clé publique remplacée change le code de contrôle, que la personne compare.
- **Messages bornés** : `parseMessage` ne laisse passer que six genres exacts, un identifiant de la
  forme voulue et un code du bon genre (invitation ou réponse) de 400 000 caractères au plus ; le reste
  est ignoré. Les noms montrés sont nettoyés (`cleanLabel`) et posés par `textContent`. Rien n'est gardé :
  ni stockage, ni écriture dans le document.
- **Sans canal** (pas de `BroadcastChannel`, autre profil, onglet fermé) : le copier-coller est
  inchangé et reste le repli. La SOURCE dit au bout de trois secondes que personne n'a répondu, et à quoi
  cela peut tenir.

## La clé du formulaire de réception

- **Une clé par réception** : Grist donne une clé par page partagée, et cette clé lit aussi les
  colonnes des tables de tous les formulaires de la page, descriptions et options comprises (vérifié). Chaque
  journal a donc son formulaire sur sa propre page, à la racine de la liste des pages. Les formulaires
  publiés par une version d'avant la 0.5 sur une même page sont signalés (« Lien commun à
  d'autres formulaires ») avec un bouton qui les sépare.
- **Ce qu'elle permet** (vérifié) : ajouter des lignes au journal de sa réception ; lire les
  colonnes de ce journal, leurs descriptions et leurs options (donc la note de la réception, dont
  le secret : vérifié sur la 0.18, où la note est dans les options), et
  le nom et l'identifiant du document. Elle ne lit aucune ligne, ne modifie ni ne supprime rien,
  et n'atteint pas le journal d'une autre page (403 en écriture, 404 en lecture).
- **Qui la connaît** : la personne qui l'a copiée, les propriétaires de la SOURCE (réglages du
  webhook), et, en Échange, quiconque a vu le code d'invitation. Le widget ne l'écrit dans aucune
  table ni note, et la masque partout à l'écran, messages d'erreur de Grist compris
  (`…/api/s/Ab12…/…`).
- **Signatures** : chaque destinataire a sa clé de signature (tirée des clés publiques des deux
  codes, voir plus haut). Côté SOURCE, elle est dans la ligne `signature` de `Synchro` (réservée
  aux propriétaires), rangée sous l'identifiant du webhook ; la CIBLE la garde dans la
  note (les options) de la colonne `id_sync` de ses destinations, **pas** dans la note du journal,
  que la clé du formulaire lit ; une règle d'accès cache cette colonne aux lecteurs (mémo « clé de
  signature cachée aux lecteurs »). Les formules de `Synchro` signent chaque liste de clés et chaque lot
  pour chaque destinataire de l'export (HMAC-SHA256 de l'empreinte de l'export, de la table, du
  type, des colonnes et du contenu, rangé sous l'empreinte de sa clé) ; le widget signe la ligne
  « fin » pour le seul destinataire concerné. La CIBLE efface sans effet, et compte parmi les
  « Arrivées suspectes », toute ligne sans signature valide pour sa clé (vérifié, y compris un lot
  signé avec la clé d'un autre destinataire du même export) ; une liste de clés vide non signée
  n'est lue que comme vide, sans les colonnes qu'elle annonce. Révoquer un destinataire efface sa
  clé : plus rien n'est signé pour lui (vérifié). Une réception branchée avant la 0.8 ne connaît
  pas de clé : elle accepte les envois non signés jusqu'à une nouvelle invitation, et sa carte le
  dit ; une réception de la 0.8 ou de la 0.9 garde la clé commune de son export (la SOURCE la
  garde tant qu'un de ses webhooks n'a pas la sienne) jusqu'à une nouvelle invitation. Qui a la
  clé du formulaire **et** la clé de signature de cette réception (un lecteur de la CIBLE peut
  lire cette dernière) peut encore forger pour elle seule : couper le lien y met fin. En Échange,
  chaque côté signe son envoi de retour avec la clé de retour, tirée de même (vérifié : un lot
  signé avec une clé tirée de l'invitation seule est rejeté par le document qui invite).
- **Sceau des lignes dépliées** : la clé du formulaire peut créer une ligne avec n'importe quelles
  colonnes, donc une ligne qui ressemble à une version déjà dépliée, qui n'aurait jamais été
  contrôlée. La CIBLE scelle donc chaque version et chaque liste qu'elle déplie (colonne
  `Sync_Sceau` du journal : HMAC-SHA256, avec la clé de signature de la réception, de l'export, de la
  table, de la clé, de l'horodatage, de `Supprime` et du contenu). Une ligne dépliée au sceau
  faux ou absent est effacée sans effet et comptée parmi les « Arrivées suspectes » (vérifié). L'empreinte de la clé est notée dans la note du journal : à la première
  fois, ou quand une nouvelle invitation change la clé, les lignes dépliées déjà là sont scellées ;
  ensuite, une clé introuvable (destination effacée, description vidée) arrête la recopie de ce
  journal au lieu de tout accepter. Une reprise (nouvelle invitation pour la même réception) tire
  toujours une nouvelle clé : elle se confirme, fiche de la SOURCE affichée.
- **Dates du futur** : une version ou une liste datée de plus de 10 minutes après l'heure de la
  CIBLE est rejetée (même instance, même horloge) : elle l'emporterait sur toutes les vraies.
- **Suppressions** (depuis la 0.13.4, décision d'Antoine du 9 novembre : « côté CIBLE on est passif,
  la SOURCE répond de ses données ») : la CIBLE applique les suppressions de la SOURCE telles quelles,
  quel qu'en soit le nombre, Renforcé compris. Avant, une vague (plus de 10 lignes et 20 %, ou toute
  suppression en Renforcé) attendait « Appliquer » ou « Ignorer » sur la carte. La signature et le
  sceau (0.9, 0.10) ferment déjà la liste forgée par une clé de formulaire ; la CIBLE qui veut garder
  ses lignes coche **Archive**. C'est la SOURCE qui est avertie, après coup : plus de 10 lignes et
  plus de 20 % d'une table de l'export disparues (suppressions ou sortie du filtre) donnent un avis
  de 24 h sur la carte de l'export et une ligne d'historique, avec le rappel de Ctrl+Z.
- **Ce que la CIBLE accepte** : l'expéditeur fait foi pour le contenu de son export (versions,
  suppressions, colonnes ajoutées à l'export, tables proposées). Une table nouvelle n'est jamais
  rangée sans l'accord d'un éditeur ; une colonne nouvelle prend un nom libre dans la destination,
  jamais celui d'une colonne existante. Une ligne qui ne peut pas venir du webhook de cet export
  (autre export, type inconnu, contenu illisible, nom de table invalide) est effacée sans effet et
  comptée ; une arrivée anormale est signalée (« Arrivées suspectes ») avec un bouton pour couper
  le lien. Aucun nom reçu ne peut viser une propriété des objets JavaScript (`__proto__`…), et les
  volumes sont bornés (100 000 lignes par lot, 1 000 clés trop grosses et 200 tables suivies par
  journal, 500 lignes reçues par passage). Une date d'arrivée hors bornes ne peut pas casser
  l'affichage, et une carte qui ne se dessine pas laisse les autres, et ses boutons « Couper le
  lien » et « Arrêter », à leur place.
- **Fin d'un envoi** : quand la SOURCE révoque un destinataire, supprime l'export ou arrête un
  Échange, son widget envoie d'abord une ligne « fin » à l'adresse du webhook, puis l'efface ; la
  carte de la CIBLE affiche « Coupé par la SOURCE ». Cette ligne est signée ; pour une réception
  sans clé de signature (branchée avant la 0.8), qui a la clé du formulaire peut la forger : la
  carte le dirait à tort, jusqu'aux données suivantes, qui effacent l'avis. Rien n'est supprimé.
- **Historique et valeurs retouchées** : la colonne `Sync_Avant` du journal garde, pour
  l'historique, les valeurs qu'une recopie a remplacées dans la destination (colonnes modifiées
  seulement) et le numéro d'une ligne supprimée. Ces valeurs restent dans le document, visibles de
  qui lit le journal comme les versions reçues ; la clé du formulaire ne lit pas les lignes, et la
  purge efface les versions remplacées. Qui a la clé peut écrire cette colonne : l'historique
  montrerait un « avant » faux, comme le ferait une version forgée ; rien n'est recopié depuis
  elle. Les retouches faites à la main se calculent à l'affichage ; seules deux marques s'écrivent :
  une colonne reçue effacée ici, dans la note du journal (que la clé ne peut pas écrire), et l'état
  `partie` d'une version dont la ligne a quitté la SOURCE alors qu'elle n'était plus ici. Qui a la
  clé peut écrire cet état sur une version : la carte tairait alors une ligne effacée ici, rien de
  plus ; « Corriger » ne recopie que les dernières versions reçues, comme la recopie normale.
- **Échange rangé dans une table existante** : avant de brancher le retour, la CIBLE confirme la
  liste des colonnes de cette table qui partiront vers le document qui invite (nommé tel que Grist
  le donne).
- **Rattachement** : si la CIBLE a choisi une colonne commune pour une table existante, une ligne
  locale sans clé dont la valeur est égale à celle d'une ligne reçue est rattachée à celle-ci
  (puis tenue à jour par la SOURCE).
- **Test du lien** : une ligne marquée d'un nombre tiré au hasard part par la clé et doit arriver
  dans le journal de cette réception ; le lien d'un autre formulaire ou d'un autre document est
  refusé (vérifié), car la réponse y enverrait les données.
- **Couper le lien** : la page du formulaire change de clé (l'ancienne n'écrit plus, vérifié), ou
  le formulaire quitte une page commune ; la SOURCE révoque puis réinvite, et la même réception
  reprend. **Arrêter la réception** efface le journal, son formulaire et sa page, donc la clé.

## Qui peut quoi

- SOURCE : seul un **propriétaire** crée, suspend ou supprime un webhook, donc branche ou révoque
  un destinataire, et lui seul voit et modifie les lignes de `Synchro` (règles posées par le
  widget, voir plus haut). Un éditeur voit « réservé aux propriétaires » à la place des cartes (depuis
  la 0.19, sans Échange, la table lui est refusée tout entière : il retrouve l'accueil grisé, comme un lecteur) ; il
  ne peut élargir ce que reçoivent les destinataires branchés que si Grist lui laisse modifier la
  structure (réglage par défaut, voir plus haut).
- CIBLE : un **éditeur** accepte une invitation, range les tables et recopie. Les journaux sont
  réservés aux éditeurs (règle de mémo « Synchro : journaux réservés aux éditeurs », case cochée par
  défaut à l'acceptation) : ils gardent les versions reçues et ce qu'elles ont remplacé, quelles
  que soient les règles des tables de destination. Un lecteur ne voit donc pas les réceptions,
  seulement les boutons grisés. Seul un propriétaire peut poser cette règle : une réception
  acceptée par un éditeur le dit sur sa carte jusqu'à ce qu'un propriétaire ouvre la page. Un
  Échange demande un propriétaire.

### Ce que voit un lecteur ou le lien public

Vérifié le 12 novembre 2026 (Grist 1.7.22, une SOURCE et une CIBLE branchées, toutes deux partagées par
lien public en lecture seule, requêtes anonymes et navigateur sans compte ; sonde rejouable :
`tests/e2e/tools/probe-public.mjs`). Un lecteur nommé voit la même chose.
- **Caché** : les lignes et colonnes de `Synchro` (SOURCE) et des journaux (CIBLE, case « réservés
  aux éditeurs » cochée et règle posée par un propriétaire). Elles manquent à la liste des tables,
  aux enregistrements, au SQL (403), aux exports CSV et XLSX, au téléchargement du document (403), à
  l'historique (« bloqué par les règles d'accès »), à « Code view » et aux instantanés ; la page
  « Données source » ne les liste pas. Les règles d'accès, les partages (`_grist_ACLRules`,
  `_grist_Shares`) et la liste des webhooks sont réservés aux propriétaires : **la clé d'écriture
  d'un formulaire n'est lisible nulle part** (elle est dans la base de Grist et dans l'adresse du
  webhook). Le widget montre au lecteur l'accueil grisé, sans rien lire.
- **Notes du widget, corrigé en 0.18 (moteur 3.0.0)** : Grist vide, dans la table de métadonnées
  `_grist_Tables_column` (`GET /api/docs/<id>/tables/_grist_Tables_column/records`, sans identifiant),
  le nom, le titre, la formule, le type et les options des colonnes qu'un lecteur ne peut pas lire,
  **mais pas leur description**. Jusqu'à la 0.17 le widget rangeait ses notes dans ces
  descriptions : un visiteur du lien public lisait, côté SOURCE, les exports, le nombre de lignes,
  l'historique des envois (courriel, document et équipe de chaque destinataire) et la **clé privée**
  d'une invitation en attente ; côté CIBLE, le **secret** de l'invitation, le courriel et le
  document de la SOURCE, les clés publiques, les tables et colonnes, et, dans la description de
  `id_sync` (colonne que le lecteur voit), la **clé de signature** de chaque réception. Depuis la
  0.18 les notes sont dans les **options** des colonnes (clé `syncNote`, `columnNote` de
  `logic/common.js`), que Grist vide quand la colonne est cachée (`Synchro_Export` pour tout
  lecteur, `Synchro_Ids` d'un journal réservé), et la colonne `id_sync` des tables qui portent une
  clé de signature est cachée aux lecteurs par une règle d'accès (`keyAclRules`, posée par un
  propriétaire à l'ouverture d'un onglet). Vérifié : la sonde `tests/e2e/tools/probe-public.mjs`
  (`STRICT=1`) ne trouve plus de clé de signature, de clé privée ni de secret, et le parcours de
  bout en bout lit les métadonnées en anonyme sur la SOURCE et sur la CIBLE.
- **Export public** : sur une SOURCE qui a un export public, la règle générale des lecteurs (`*` → `-R`, voir
  « Lien public ») refuse aussi les tables de métadonnées (`_grist_Tables_column` répond 403 en anonyme, vu au
  parcours de bout en bout) : rien de plus n'y est lisible. Sans export public, ou sur une CIBLE, elles se
  lisent, d'où la correction ci-dessus.
- **Mémo des webhooks, corrigé en 0.19 (moteur 4.0.0)** : `_grist_Triggers` (nom, mémo, condition, table de chaque
  webhook) se lit **en anonyme sur un document public**, sans l'adresse. Le mémo portait la fiche du destinataire : courriel,
  document, équipe/nom. Il n'est plus qu'un jeton opaque (`r-` et douze chiffres hexadécimaux, `MEMO_TOKEN`) ; la fiche est dans
  la note de la SOURCE (`dest`, options de `Synchro_Export`, cachée aux lecteurs et, sans Échange, aux éditeurs), rangée **avant**
  la création du webhook (`rememberDest`) et remise dans les webhooks que lit le moteur (`readHooks`, `identifyHooks`). Les
  webhooks d'avant sont migrés à l'ouverture par un propriétaire (`protectMemos`, un seul verrou, une seule écriture de la note,
  `PATCH` du mémo par six à la fois) ; la fiche d'un destinataire parti est retirée de la note après 10 minutes (`staleDest`).
  Vérifié (e2e) : la lecture anonyme de `_grist_Triggers` ne donne ni courriel ni identifiant de document.
- **Toujours lisible** (reste) : le nom d'un webhook (le nom de l'export), sa **condition** (identifiant de l'export, nécessaire à
  Grist) et sa table, par `_grist_Triggers` ; ils disent qu'un export de ce nom existe, pas qui reçoit. Aussi : le journal d'une
  réception dont la case « réservé aux éditeurs » est décochée se lit en entier par tout lecteur, note comprise (c'est ce que la case
  dit) ; les éditeurs et les propriétaires lisent tout, comme avant.
- **Refus de Grist à poser les règles, dit depuis la 0.19** : une règle d'une personne qui nomme une colonne effacée
  (« Invalid columns in rules for table Contacts: Prenom ») fait refuser à Grist *tout* changement de règles, donc celles du
  widget ; avant, `syncRules` l'écrivait dans la console et rien d'autre. Le refus est gardé (`ruleRefusal`), montré aux propriétaires
  des deux onglets (`rulesRefusedNotice`, avec le texte de Grist), et bloque « Nouvel export » tant qu'il dure : le widget ne pose
  pas de données qu'il ne sait pas protéger. Il ne touche **jamais** aux règles d'autrui.
- **Audit offensif de la 0.19** (12 novembre, Grist 1.7.22, sondes `tests/e2e/tools/probe-surfaces.mjs` et `probe-gaps.mjs`, rejouables) :
  415 routes de lecture de l'API lues par quatre rôles (visiteur du lien public, lecteur nommé, éditeur nommé, détenteur de la
  clé d'un formulaire) sur une SOURCE et une CIBLE branchées. Constaté protégé : tables de données, enregistrements, SQL, CSV, XLSX,
  téléchargement et sqlite, historique, instantanés, webhooks, règles d'accès, partages (403) ; la clé d'écriture d'un formulaire
  n'est lisible nulle part (elle est dans l'adresse du webhook, réservée aux propriétaires) ; l'adresse de l'iframe du widget ne
  contient pas l'identifiant du document ; `localStorage` du widget ne garde aucun secret (la reprise d'un assistant après le rechargement des règles ne note qu'une heure,
  dans le stockage de l'onglet seulement). La clé d'un formulaire n'écrit ni métadonnées, ni autre table, ni SQL, ni règles, et ne lit que les
  colonnes, descriptions et options du journal (la note du journal, voulu : voir « La clé du formulaire de réception »).
- **Mise à niveau** : un document d'avant la 0.18 est lu tel quel (la note de la description est
  encore lue), puis déplacé dans les options à la première ouverture d'un propriétaire (SOURCE) ou
  d'une personne qui peut écrire (CIBLE, premier passage de recopie), sans rien perdre : la note
  des options fait foi, la description d'avant est vidée. **Jusqu'à ce déplacement, et sans règle
  posée, rien n'est caché**. Un onglet resté ouvert sur une version d'avant la 0.18 ne lit pas les
  notes déplacées (il les croit vides et pourrait les réécrire) : recharger les onglets ouverts.
- **Ce que cela permet** : rien d'écrit, même avant la correction. Pour forger un lot il faut la
  clé du formulaire, que le lien public ne donne pas ; la clé de signature lue rendait seulement
  inutile, pour un visiteur qui aurait aussi cette clé par ailleurs, la défense « clé de
  formulaire seule » (voir « La clé du formulaire de réception »). Ce qui fuyait, c'était de
  l'information : courriel d'un propriétaire, qui échange avec qui, combien de lignes. Cause :
  Grist (1.7.22, `CensorshipInfo`), à signaler à grist-core. La même lecture sur DINUM reste à
  faire (`…/api/docs/<id>/tables/_grist_Tables_column/records` dans une fenêtre privée) : une
  note déplacée y apparaît vide de sa description et sans `syncNote`.

## Ce que le widget écrit et garde

- Pas de table de réglages. Les destinataires branchés sont les webhooks eux-mêmes ; leur mémo n'est qu'un jeton
  depuis la 0.19, la fiche (courriel, document, équipe) est dans la note de la SOURCE (`dest`), visible par les
  propriétaires dans les paramètres du document comme dans le widget.
- SOURCE : `id_sync` et `MajLe` dans chaque table envoyée (et la case `Supprime` en Échange), la
  table `Synchro` (dont une ligne `signature` par export, qui garde la clé de chaque
  destinataire), une note (exports, invitations en attente avec l'empreinte de leur secret, leur
  date et leur paire de clés, pauses, empreintes abrégées des fichiers déjà envoyés) dans la
  les options de `Synchro_Export` (0.18 ; avant, sa description), et ses règles d'accès,
  reconnues à leur mémo. En Échange, la clé de retour de chaque participant est dans les options
  de la colonne `id_sync` des tables qui reçoivent le retour, une par journal de retour.
- CIBLE : les tables de destination (plus `id_sync`, masquée de la page et cachée aux lecteurs,
  dont les options gardent la clé de signature), les pièces jointes reçues, un journal par export reçu avec sa note (destinations,
  colonnes, tables refusées, fichiers attendus, secret, clés
  publiques des deux côtés) dans les
  options de `Synchro_Ids`, le formulaire de réception sur sa page, et la règle des journaux.
- **Actions de structure** (création, renommage, suppression de tables ou de colonnes ; toutes passent par
  `grist.docApi.applyUserActions`, donc avec les droits de la personne, et s'annulent par Ctrl+Z ou l'historique
  du document) :
  - *créer* : la table `Synchro` et ses colonnes (premier export), `id_sync`, `MajLe`, `RecalculLe` dans une table
    envoyée (à l'enregistrement d'un export), un journal et son formulaire (réception acceptée, retour d'un
    Échange), une table de destination ou des colonnes de destination (choisies à l'étape Destinations, avec un
    avertissement pour une table neuve ; « Corriger » recrée une colonne reçue effacée), et, sur le bouton « Ajouter le
    widget à la page de la table reçue » de la carte d'une réception (0.20, après une fenêtre qui le dit), une section
    « Personnalisée » du widget lui-même sur la page d'une table reçue : même adresse que le widget qui tourne, **sans
    l'accès accordé** (le niveau `access` de la section reste à `none` : Grist demande l'accès complet à la personne, dans
    son panneau de droite ; le widget ne se le donne jamais), une seule fois par page ;
  - *modifier* : la formule ou le déclenchement des colonnes que le widget a créées (`MajLe`, `RecalculLe`, colonnes
    de `Synchro`), et, à la CIBLE, le type d'une colonne qu'il a créée et qui est encore vide (Référence conservée), ou, sur le
    clic d'un propriétaire après confirmation (« Refaire les références », 0.27), celui d'une colonne qu'il a créée et que la SOURCE
    garde en lien mais qui contenait déjà du texte ;
  - *renommer* : seulement une table nommée `Synchro` qui n'est pas la sienne, sur le bouton de la carte, nom proposé
    modifiable ;
  - *supprimer* : ses tables techniques (`Synchro` quand le dernier export est supprimé, un journal quand la
    réception est arrêtée ou l'invitation retirée), toujours après une confirmation ; une table de destination
    seulement si cette réception vient de la créer, qu'elle est encore vide et que la personne revient en arrière
    dans l'assistant ; dans `Synchro`, la colonne `manualSort` et, après une fenêtre qui les liste (case « J'ai
    sauvegardé » s'il y a des valeurs), les colonnes en trop.
  - *métadonnées* (tables `_grist_*`) : les options (et, pour une note d'avant la 0.18, la description) des colonnes
    qui portent ses notes, les options des colonnes qu'il a créées, le nom et la place de la page d'un formulaire, la description du partage de ce formulaire, et ses
    règles d'accès, reconnues à leur mémo.
  Hors de ses propres tables et colonnes, le widget ne renomme et ne supprime rien de lui-même : les deux seuls cas
  qui touchent ce qu'une personne a fait (une table `Synchro` créée à la main, des colonnes ajoutées à la table
  `Synchro`) se font sur son clic, après une fenêtre qui dit ce qui va changer.
- Un renvoi ne modifie jamais les tables de la personne : il n'écrit que dans `Synchro`.
- Depuis la 0.12 : SOURCE, la note garde aussi l'historique des envois que le widget a conduits
  (30 événements au plus par export : date, genre, nom ou courriel du destinataire coupé à 80
  caractères, nombre de lignes), effacé avec l'export ; CIBLE, la case `Supprimee_a_la_source`
  d'une réception en archive, la règle « lecture seule » d'une réception verrouillée (reconnue à son
  mémo), et dans les colonnes que le widget a créées, le type Référence et les listes de choix et
  formats reçus (`widgetOptions`, clés connues aux valeurs contrôlées). Le diagnostic à copier ne
  s'écrit nulle part : il est construit à l'affichage et copié par la personne.
- Depuis la 0.16 : si l'export envoie la mise en forme, la CIBLE écrit dans les colonnes qu'elle a créées les
  options d'en-tête et de couleur (clés connues, couleurs `#RRGGBB` ou `#RRGGBBAA`), et des **règles de mise en forme
  conditionnelle** : une colonne cachée `gristHelper_ConditionalRule…` par règle (formule réécrite, voir
  « Risques acceptés ») et les styles dans les options de la colonne. Le réglage de langue et de devise du
  document (`_grist_DocInfo`) n'est écrit que sur le clic confirmé d'un propriétaire. Les règles et styles
  posés sont suivis par colonne dans la note du journal (`styled`).
- Depuis la 0.16.1 : si l'export envoie les descriptions, la CIBLE écrit la description (`description` de
  `_grist_Tables_column`) des colonnes qu'elle a créées et celle de la table (section de données brutes,
  `description` de `_grist_Views_section`) si elle est vide, une fois (`described`, `tabled` dans la note). Jamais
  sur `id_sync` ni dans la note du journal. « Reprendre depuis la SOURCE » les remplace sur demande.
- Depuis la 0.17.0 : si l'export envoie les formules (case à part, décochée d'emblée, après un message), la CIBLE ne
  pose **rien toute seule**. Sur le clic d'un propriétaire (« Reprendre depuis la SOURCE », case « Formules », après
  lecture de chaque formule et case « J'ai lu »), elle transforme en colonne de formule (`ModifyColumn` : `isFormula`,
  `formula`) les colonnes que le widget a créées (`own`) dont la formule n'a pas d'objection ; la colonne reçoit alors son
  résultat et n'est plus recopiée. Jamais sur une colonne qui existait déjà, sur `id_sync`, ni en Échange. Rien n'est noté
  de plus dans la note du journal (l'état se lit dans la destination).

## Chaîne d'approvisionnement

Le widget a un **accès complet** au document : qui peut modifier son code peut lire et écrire le
document de quiconque l'ouvre. Le risque n'est pas le transit des données mais l'origine du code.
Pour un usage en production :

- installer le widget depuis la **galerie de l'instance** quand il y est ; sinon n'utiliser que
  l'adresse officielle, celle que donnent les consignes du widget (`WIDGET_URL` dans
  `js/config.js` ; seule la version de test, servie depuis `BETA_URL`, donne la sienne), jamais
  une adresse reçue par courriel ;
- héberger une **copie figée** du dépôt (version relue, étiquette Git) sur un serveur de
  l'organisation, plutôt que la branche `main` sur GitHub Pages, et y changer `WIDGET_URL` ;
- ajouter cette adresse à la liste des widgets de l'instance, et ne garder dans `js/config.js` et
  la politique de `index.html` que les instances Grist utilisées (le pas à pas, illustré :
  [`docs/08-auto-hebergement.md`](docs/08-auto-hebergement.md) ; `tests/unit/instances.test.mjs`
  échoue si la liste du code et celle de la politique ne disent pas la même chose) ;
- relire le code à chaque mise à jour : environ 15 700 lignes de JavaScript commenté, sans dépendance.

**Webhooks limités à l'instance.** Un webhook part du serveur Grist, page fermée : une copie piégée
du widget, ouverte par un propriétaire, pourrait en créer un vers n'importe quelle adresse que le
serveur accepte. La barrière est un réglage de l'instance, la liste des domaines autorisés pour les
webhooks (`ALLOWED_WEBHOOK_DOMAINS` de Grist), qui vaut pour ce widget comme pour tout propriétaire
d'un document :

- sur `grist.numerique.gouv.fr`, les webhooks sont limités à l'instance (réponse du porteur du
  projet, 12 novembre 2026 ; point 14 de l'audit de sécurité du 16 octobre) : un webhook vers un
  autre serveur est refusé, et qui en a besoin doit écrire aux administrateurs pour demander l'ajout
  de son adresse à la liste. Le widget n'en a pas besoin : ses envois vont d'un document à l'autre
  de la même instance ;
- sur une autre instance, vérifier ce réglage auprès de son administrateur. S'il n'autorise pas
  l'instance elle-même, Grist refuse de créer le webhook (403 « Provided url is forbidden », vérifié
  sur Grist 1.7) : le widget le dit au branchement (`error.webhookForbidden`) et rien n'est branché ;
  il faut alors demander l'ajout de l'adresse de l'instance à la liste. S'il autorise tout (`*`),
  cette barrière n'existe pas : raison de plus pour n'installer que la copie officielle ou une
  copie figée.

## Ce que le widget ne fait pas

- Aucune requête vers un service tiers, aucune télémétrie, aucune donnée hors de Grist.
- Aucune clé d'API personnelle : seuls le jeton court du document et la clé du formulaire servent.
- Aucune lecture du document CIBLE depuis la SOURCE. La CIBLE ne lit la SOURCE qu'en mode lien
  public, sans identifiant, et seulement ce que les règles d'accès laissent voir.

## Risques acceptés

- L'expéditeur d'un export peut écrire dans les tables de destination ce que l'export pourrait y
  écrire : c'est le principe de la synchro (une date du futur est refusée ; la CIBLE n'a plus de
  retenue sur les suppressions depuis la 0.13.4, voir « Suppressions » plus haut). Seule la SOURCE peut le faire : qui a obtenu
  la clé d'une réception ne le peut plus sans la clé de signature de cette réception (signature et
  sceau), ni un autre destinataire du même export, sauf pour une réception branchée avant la 0.8. Couper le lien y met fin. Pour un export qui envoie des pièces jointes, la SOURCE dépose
  ses fichiers (25 Mo chacun au plus) : un fichier reçu s'ouvre avec la même prudence qu'une pièce
  jointe de courriel ; dans un Échange, un participant peut aussi faire déposer des fichiers (25 Mo au plus chacun) dans le
  document de A, dans les colonnes que A a cochées seulement, et A les relaie aux autres : c'est le pouvoir qu'il a déjà
  sur les valeurs, avec le contenu en plus. Qui n'a que la clé du formulaire peut faire attendre des morceaux de fichier
  dans le journal (50 Mo au plus, un jour au plus), sans dépôt.
- Les lignes dépliées présentes quand la CIBLE pose son sceau pour la première fois (ou pour une
  nouvelle clé) sont tenues pour bonnes. Un onglet resté ouvert sur une version d'avant la 0.9
  déplierait sans sceau : ces lignes seraient effacées comme suspectes, et la SOURCE renverra. Un
  onglet CIBLE resté ouvert sur la 0.9 ne lit pas les signatures de la 0.10 : les lots arrivés
  pendant ce temps sont rejetés ; recharger la page, puis « Tout renvoyer » côté SOURCE.
- La clé privée d'une invitation en attente est gardée dans la note de `Synchro` jusqu'à
  l'approbation : qui peut lire cette note (propriétaires, éditeurs qui ont le droit de
  structure ; plus un lecteur du document depuis la 0.18, voir « Ce que voit un lecteur ou le lien
  public ») et voit la réponse pourrait tirer la clé de ce destinataire. Chaque destinataire voit
  combien de signatures porte un lot, donc combien de destinataires a l'export.
- Chaque passage de la CIBLE relit son journal en entier, morceaux de fichiers en attente compris
  (50 Mo au plus) ; une seconde fois seulement si la recopie y a écrit.
- La clé du formulaire lit la note de son journal, dont le secret de l'invitation, et le nom du
  document : le secret ne sert plus une fois l'invitation acceptée.
- **Clé du formulaire et gel passager du moteur de la CIBLE (Grist 1.7.22, vérifié le 17 novembre 2026,
  `tests/e2e/tools/probe-form-key-meta.mjs`)** : par la route des enregistrements, la clé d'un formulaire essaie d'écrire dans
  les tables de métadonnées du document (`_grist_*`). Grist refuse (403, « Only owners can modify access rules ») les règles
  d'accès, les partages, les réglages du document, les webhooks, les colonnes et les vues : rien de la structure, des droits
  ni des webhooks ne change. **Une seule exception, un défaut de Grist** : une ligne ajoutée à `_grist_Tables` passe le
  contrôle de droits, le moteur de calcul lève une erreur (« KeyError ») et reste de travers, sans que rien ne soit
  enregistré : tant que le document n'est pas rechargé (sortie de mémoire après inactivité, redémarrage du serveur), **toute
  écriture dans le document échoue** (« KeyError '<nom>' »), y compris celles du propriétaire et de la recopie. Qui tient la clé
  d'un formulaire (la SOURCE, ou une personne à qui la clé a été divulguée) peut donc geler les écritures du document de la
  CIBLE, aussi souvent qu'il veut. Rien n'est lu, rien n'est écrit : c'est un déni de service passager, du même ordre
  que le remplissage du journal par la même clé. **Le widget ne peut rien y faire** (le défaut est dans le contrôle de droits
  de Grist) ; à signaler à Grist Labs et à l'administrateur de l'instance ; en cas de gel, faire recharger le document
  (l'administrateur de l'instance, ou sa mise en veille) et, si la clé a pu fuiter, couper puis refaire le lien de la réception.
- **Nom du document de la SOURCE (0.13.5)** : saisi par la personne, il n'est pas vérifié ; qui fait une
  invitation peut y écrire ce qu'il veut (comme l'e-mail et le nom de l'export) et faire passer son document
  pour un autre auprès d'une CIBLE peu attentive. Le lien mène à l'identifiant réel du document, l'infobulle
  rappelle que le nom est dit par la SOURCE, et le code de contrôle, comparé par téléphone, reste ce qui
  prouve qui est à l'autre bout.
- Un envoi en échec bloque la file de tous les webhooks du document SOURCE environ 15 minutes
  (comportement de Grist) : un destinataire qui refuse ses envois retarde les autres. Le widget
  le signale et propose de débloquer la file.
- Sans Redis, la file d'envoi de Grist vit en mémoire : un redémarrage du serveur la perd (le
  widget renvoie ce qui manque à la prochaine ouverture par un propriétaire).
- **Renforcer la sécurité d'un partage d'avant les clés (0.21, délai de 7 jours)** : un partage branché avant les clés de signature n'a pas de
  clé propre au destinataire ; rien ne le coupe, il se renforce quand la personne le décide (invitation de la SOURCE qui remplace l'envoi,
  code collé par la CIBLE, réponse approuvée). **Risque accepté** (décision du porteur, 6 novembre) : entre le code collé par la CIBLE et la
  première livraison signée avec la nouvelle clé, 7 jours au plus, la CIBLE accepte aussi les envois SANS signature (l'ancien webhook n'est pas
  encore remplacé) ; une ligne forgée avec la clé du formulaire peut y passer, exactement comme avant le renforcement (qui n'a jamais eu de
  signature). Une signature fausse reste rejetée, une ligne `fin` non signée n'est jamais tolérée, et le délai écoulé, l'ancien envoi est refusé
  comme tout envoi non signé (la carte le dit : « Renforcement interrompu »). « Revenir à l'ancien fonctionnement » retire la clé préparée.
  Un Échange d'avant les clés ne passe pas par là (sa reprise tire déjà de nouvelles clés).
- **Références entre tables (0.27)** : garder le lien d'une colonne Référence ou Liste de références est un choix de la personne qui envoie,
  colonne par colonne ; quand la table visée n'est pas dans l'export, la garder l'**ajoute**, d'emblée avec la seule colonne que la Référence affiche ;
  depuis la 0.28 la personne peut y prendre **toute la table** (sauf ses Pièces jointes, qui ne partent que cochées) ou les colonnes qu'elle coche
  (le bloc « Ajoutée pour un lien » et la ligne « Part en plus des tables cochées » le disent avant l'enregistrement, aucune table ne s'ajoute
  sans ce choix, et ses lignes se filtrent comme celles des autres tables : même effet que cocher la table à l'étape Tables, donc même droit
  d'envoyer ses colonnes ; une Référence de la table prise en entier est un choix de plus, valeurs seules d'emblée). Sont envoyés en plus : la clé (UUID) de la ligne visée, ou la liste des clés des lignes visées, dans le lot signé
  et scellé comme le reste ; rien d'autre de la table visée. Un export en lien public vérifie, comme avant, qu'aucune règle d'accès d'autrui
  ne cache de lignes ou de colonnes des tables lues (`hiddenTables`, refus `publicHiddenEdit`), tables visées comprises. À la CIBLE, la
  conversion d'une colonne en Référence ne touche que les colonnes créées par le widget ; une colonne remplie de texte n'est refaite que sur le
  clic d'un propriétaire, qui remplace ses cellules par le lien envoyé (Ctrl+Z défait). Une Liste de références dont la liste de clés a été
  falsifiée ne peut viser que des lignes de la table reçue de cet export (les clés sont résolues dans cette table, 0 ou vide sinon).
- **Ce que le journal garde, et le bouton « Effacer l'historique » (0.19.1)** : le journal d'une réception garde la dernière version de
  chaque clé (copie de ce qui est dans la destination), l'avant de chaque modification et le numéro des lignes supprimées (`Sync_Avant`), et les
  valeurs de la dernière version d'une clé supprimée à la SOURCE. Décision du porteur (12 novembre) : aucune purge automatique. Un
  propriétaire peut les vider sur demande, depuis la carte de la réception (confirmation, ne se défait pas) : l'avant et les valeurs supprimées
  sont vidés (la version, rescellée, garde sa clé, son heure et son état), l'historique de la carte repart de zéro (`histo`). En Échange rien n'est
  vidé (les valeurs servent à comparer). Côté SOURCE, le bouton de l'historique des envois efface la note (noms, courriels, nombres) et nettoie les
  journaux de retour d'un Échange ; des repères d'ajout et de retrait restent, sans nom, pour détecter un webhook supprimé à la main. **Limite** :
  l'historique propre à Grist (« Historique du document », annuler) garde les valeurs ; le widget n'y accède pas. Qui lit le document avant
  l'effacement a pu les lire.
- **Fuites d'information, reste après l'audit de la 0.19** (voir « Ce que voit un lecteur ou le lien public ») :
  - le nom d'un webhook (nom de l'export) et sa condition (identifiant de l'export) se lisent par `_grist_Triggers` sur un
    document public : ils disent qu'un export existe, pas qui reçoit ni quoi ;
  - dans un document qui a un **Échange**, les éditeurs gardent un accès limité à `Synchro` pour la recopie : ils lisent
    donc la note de la SOURCE (fiches des destinataires, invitations en attente) par les métadonnées. Les éditeurs de ce
    document sont de confiance par construction (ils écrivent déjà dans les tables échangées) ;
  - la note du journal d'une réception (secret de l'invitation, courriel et document de la SOURCE, clés publiques) est lue par les
    éditeurs de la CIBLE et par la clé du formulaire : voulu, le secret est nécessaire pour refaire la réponse ; le lien du
    formulaire reste un droit d'écriture à ne jamais diffuser ;
  - pendant l'assistant « Recevoir », le journal et son formulaire existent environ une seconde avant que la règle qui les
    réserve aux éditeurs ne soit posée : le journal est alors vide (aucune donnée n'est encore arrivée) ;
  - une SOURCE qu'une version d'avant la 0.19 a déjà ouverte reste sans ces protections jusqu'à l'ouverture de l'onglet
    Envoyer ou Recevoir par un propriétaire (migration des mémos, règles de `Synchro`) ;
  - un onglet resté ouvert sur un moteur 3.x repose les règles d'avant (rechargement du document) et réécrit la fiche
    dans le mémo : recharger tous les onglets après la mise à niveau ;
  - les descriptions, formats, listes de choix et formules (si la case est cochée) des colonnes partent *vers les
    destinataires* par défaut : c'est le principe de l'export, pas une fuite vers un tiers ;
  - le widget se charge depuis GitHub Pages (chaîne d'approvisionnement, voir plus haut) et ne peut pas être vérifié par Grist.
- **Lecture seule (0.12)** : le verrou d'une réception protège ses tables des retouches à la main des
  non-propriétaires, pas d'un éditeur du document CIBLE. La règle posée dans les règles d'accès
  (mémo `LOCK_MEMO`) est la seule référence : la note du journal peut demander un verrou (`verrou`),
  jamais le retirer ; seul un propriétaire le lève, par les options de la réception
  (`syncRules({ release })`), et le passage suivant d'un propriétaire remet dans la note ce que la
  règle dit (`lockMirrors`). Une règle dont la table n'est plus reçue est retirée. Reste qu'un
  éditeur écrit dans le journal de réception et lit la clé de signature des destinations : il peut y
  forger une version que la recopie d'un propriétaire écrira. Grist ne cache pas aux éditeurs les
  métadonnées de colonnes ni ne leur retire le droit de structure par défaut : aucune règle du
  widget n'arrête un éditeur malveillant. Les options d'une réception ne sont proposées ni en
  Échange ni en lien public.
- **Règles de mise en forme conditionnelle (0.16)** : une règle est une formule Python évaluée par Grist, donc
  l'injection de formule est le risque. Elle ne passe jamais telle quelle : `js/engine/logic/rules.js` la lit
  par une grammaire fermée (comparaisons, `et`/`ou`/`non`, `in` avec une liste littérale, `is None`, `+ - * /`,
  `TODAY()`, références de colonne `$Col` ou `rec.Col`, nombres et textes courts sans guillemet, barre oblique,
  caractère de contrôle ni de sens d'écriture ; 300 caractères, 60 nœuds, profondeur 12) et la CIBLE écrit
  une **formule neuve**, reconstruite à partir de l'arbre avec les noms de ses propres colonnes. Tout ce qui sort
  de la grammaire (appel de fonction, attribut, `import`, `lambda`, indice, `**`, `//`, `%`…) fait tomber la
  règle ; une colonne absente d'ici aussi. Au plus 10 règles par colonne. La grammaire ne contient ni appel de
  fonction (hors `TODAY()`) ni accès à un attribut (hors `rec.Col`, réécrit en `$Col`) : une règle ne lit donc que des
  colonnes de la même ligne et ne peut ni écrire, ni lire un autre document, ni boucler. Le tirage de règles
  abîmées de `tests/unit/robustness.test.mjs` vérifie le point fixe (ce qui est réécrit se relit à l'identique).
  Reste, comme pour toute mise en forme reçue, qu'une SOURCE peut colorer à sa guise les colonnes qu'elle a
  fait créer, et qu'un lot signé par la clé d'une réception est la seule voie d'arrivée de ces règles.
- **Descriptions (0.16.1)** : un texte libre qu'une SOURCE fait écrire dans les infobulles de la CIBLE (Grist y
  rend des liens cliquables, jamais du HTML). `logic/descriptions.js` (`cleanNote`) le nettoie : sans caractère de
  contrôle ni de sens d'écriture, lignes vides en trop retirées, 300 caractères par colonne et 500 par table au
  plus (la description des colonnes accompagne chaque envoi : le total reste loin de 1 Mo). Il est signé avec les
  colonnes, donc hors de portée de la clé du formulaire. Reste qu'un destinataire lit tout ce que la SOURCE y écrit :
  la case le dit, et chaque case est décochable (une description « interne » ne part pas si la case est décochée).
- **Ordre et colonnes cachées (0.26.0)** : que de l'affichage. La SOURCE envoie un rang par colonne (`pos`, un entier de -1 à
  100 000, contrôlé par `isPos` ; signé avec les colonnes, donc hors de portée de la clé du formulaire). La CIBLE n'écrit que
  des champs de la section de page de sa table (`_grist_Views_section_field` : retirer le champ d'une colonne, changer son
  rang), seulement pour les colonnes que le widget a créées, une fois chacune puis sur « Reprendre depuis la SOURCE » : ni
  donnée, ni droit, ni tri, ni filtre, ni vue ajoutée. Une colonne cachée reste pleine de ses données (lisibles par les
  moyens habituels de Grist), la case ne la protège pas : elle ne sert pas de masque.
- **Formules de colonne (0.17.0)** : une formule est du **Python que Grist exécute** sur les données du document :
  c'est le plus fort des éléments que la SOURCE peut faire reprendre, d'où une case à part, un message, et le clic d'un
  propriétaire. **Ce que fait le widget** (`js/engine/logic/column-formulas.js`) : la SOURCE n'envoie que le texte des
  vraies colonnes de formule, et celui de la formule par défaut d'une colonne de données (0.25 : formule de déclenchement qui ne joue que
  sur les nouvelles lignes, `fd` ; une formule qui se recalcule quand une colonne change ne part pas, elle réécrirait chez la CIBLE des valeurs
  que la SOURCE envoie déjà), ni colonne Référence ou Pièces jointes, nettoyé (pas de
  caractère de contrôle ni de sens d'écriture, 1 500 caractères par formule, 20 000 par table : une formule trop
  longue ne part pas, jamais coupée) et signé avec les colonnes (hors de portée de la clé du formulaire). La CIBLE lit
  chaque formule avant toute écriture et **refuse d'office** : un mot qui n'a rien à faire dans une formule de colonne
  (`eval`, `exec`, `open`, `getattr`, `os`, `sys`, `subprocess`, réseau, fichiers…, cherchés hors des textes, des
  commentaires et des colonnes citées), tout nom à doubles tirets bas (partout, texte compris), **tout nom qui commence
  par un tiret bas** (`random._os`, `collections._sys` : les modules permis gardent leurs modules système sous un nom
  privé, et un mot de la liste ne les trouvait pas), tout caractère hors ASCII hors des textes et les mots refusés lus
  après la normalisation que Python applique aux noms (« ｅｖａｌ » en pleine largeur est `eval`), les lecteurs d'attributs par
  leur nom que les modules permis laissent atteindre (`operator.attrgetter`, `string.Formatter().get_field`), **la fonction
  `REQUEST` de Grist** (elle envoie une requête à n'importe quelle adresse quand l'instance l'a activée : une formule
  y aurait envoyé le contenu de la table), l'intérieur de Grist (`grist`, `docmodel`, `engine`), `while`, `sleep` et `exit`
  (un calcul qui ne finit pas bloque tout le document), tout `import` hors de treize modules de calcul et de dates
  (`string` et `fractions` n'en font plus partie depuis la 0.30.4), une colonne citée qui n'est pas dans la destination ou
  y a changé de nom, **toute table de ce document qui n'est pas dans l'export, quelle que soit la façon de la lire**
  (`Nom.lookup_records`, `len(Nom)`, une table de résumé, un journal : la liste de toutes les tables d'ici est lue, plus
  seulement `lookupRecords`, `lookupOne` et `all`). Le texte n'est jamais réécrit. **Contournements trouvés à l'audit du
  17 novembre 2026** (essayés contre l'ancienne lecture, tous passaient sans objection, tous refusés maintenant,
  `tests/unit/engine-formulas.test.mjs`) : les noms privés des modules, `fractions.operator.attrgetter`,
  `string.Formatter().get_field`, `Secrets.lookup_records`, `len(Secrets)`, `REQUEST(…)`, un mot en pleine largeur, `exit()`.
  **Ce que le widget ne garantit pas** : cette lecture
  est un garde-fou, pas une preuve (Python se dissimule de bien des façons : `"{0.x}".format(…)` lit un attribut par son nom
  même quand le nom est construit à la volée, ce qu'aucune lecture du texte ne voit, et une boucle `for` sur un très grand
  `range` ou un calcul de grande puissance bloquent aussi) ; la vraie protection est le bac à sable de
  l'instance Grist et la lecture de la personne. **Vérifié le 12 novembre 2026** dans l'image Docker officielle de Grist
  (sans bac à sable renforcé) : une formule de colonne a pu `import os` et lister les fichiers du serveur. Sur une
  instance dont les formules tournent sans bac à sable, poser une formule reçue revient donc à laisser la SOURCE
  exécuter du code sur le serveur : à vérifier auprès de l'administrateur de l'instance (réglage `GRIST_SANDBOX_FLAVOR`)
  avant de proposer la case aux utilisateurs. Même avec bac à sable, une formule peut ralentir ou bloquer le document
  (boucle sans fin) : l'Historique du document permet de revenir en arrière. Aucun passage de recopie ne pose une formule
  tout seul, ni l'ouverture de l'onglet ; l'écran ne propose la case qu'à un propriétaire, et le moteur ne pose rien sans
  `restyle(journal, { formulas: true })`.
- **Langue du document (0.16)** : la SOURCE dit la langue et la devise de son document ; la CIBLE ne les valide
  que par forme (`fr-FR`, `EUR`) et ne les écrit jamais d'elle-même. Le bouton « Régler le document comme la SOURCE »
  est réservé aux propriétaires, passe par une confirmation qui dit que tout le document change d'écriture
  des nombres, et s'annule par Ctrl+Z.
- **Listes de choix (0.12)** : sans filtre de lignes, la liste complète des choix d'une colonne Choix
  ou Liste de choix envoyée (500 choix au plus) part avec la description des colonnes, y compris les
  choix dont aucune ligne n'est envoyée ; elle reste dans les lots du journal (réservé aux
  éditeurs) et dans les colonnes créées par le widget, pas dans la note du journal. **Avec un filtre
  de lignes** (`filteredColumns`), ni la liste ni les couleurs ne partent (le format part) : la
  CIBLE complète les colonnes qu'elle a créées avec les valeurs des lignes reçues
  (`valueChoiceActions`, `receivedChoices`, 500 valeurs de 200 caractères au plus), donc un choix
  n'apparaît chez un destinataire que si une ligne reçue le porte ; une ligne qui entre dans le
  filtre apporte le sien. Ne pas envoyer sans filtre une colonne Choix dont la liste est
  confidentielle. La liste d'une colonne reçue est bornée à 500 choix ; ni `HyperLink` ni
  `Markdown` ne sont repris comme affichage d'une colonne de texte.
- **Archive et effacement (0.12)** : une réception en archive garde les lignes que la SOURCE a
  supprimées, cochées `Supprimee_a_la_source` : la SOURCE ne peut ni le voir ni l'empêcher. Pour un
  droit à l'effacement, le propriétaire de la CIBLE doit supprimer ces lignes lui-même. Décocher
  l'archive ne les efface pas.
- **Diagnostic (0.12)** : il ne contient aucune valeur de table, aucun courriel, aucune adresse de
  webhook ou de formulaire, code ni clé ; les messages d'erreur de Grist qu'il cite sont filtrés
  (adresses, jetons, longs identifiants retirés). La personne le relit avant de le coller.
- **Table Synchro d'une autre personne, colonnes en trop (0.12.2)** : le widget ne reprend plus une
  table nommée `Synchro` qui n'a pas sa colonne `Synchro_Export` (`foreignSync`) : il n'y écrit rien et
  n'envoie rien tant qu'elle ne porte pas un autre nom. Il ne la renomme (`RenameTable`, rien d'effacé) ni
  ne retire des colonnes de `Synchro` (`RemoveColumn`, après une fenêtre qui nomme les colonnes, ce
  qu'elles contiennent, et demande de sauvegarder) qu'à la demande d'un propriétaire. Un envoi bloqué
  par ces colonnes est débloqué ensuite (file vidée, exports renvoyés). La table Synchro n'est pas
  effacée avec le dernier export quand une page la montre (`isOnPage` : le widget posé sur elle).
- Le paramètre `?flat=1` n'est pas documenté par Grist (couvert par ses tests depuis 2023).
- Le canal entre onglets (0.15) est audible de toute page de l'origine du widget ouverte dans le même
  navigateur, secret d'invitation et adresse d'écriture de réponse compris (voir « Canal entre onglets du
  même navigateur ») : même exposition qu'un code envoyé par courriel, devant plus de monde ; le contrôle
  du document par Grist et la comparaison du code de contrôle restent ce qui prouve à qui l'on parle.
