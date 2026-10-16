# Sécurité

Ce document s'adresse à la personne qui audite le widget. Il dit ce qui sort de quel document,
par quel canal, avec quels droits, ce que le widget refuse de faire, et les risques acceptés.
Les affirmations marquées « vérifié » ont été essayées dans un vrai Grist (test d'intégration ou essai dédié).

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
- Les codes échangés sont des **identifiants** : ils se transmettent comme un mot de passe.

## Surface

- Page statique : HTML, CSS et modules JavaScript natifs, sans bibliothèque tierce, sans étape de
  build. Le seul script externe est `grist-plugin-api.js`, chargé depuis l'instance qui affiche le
  widget si elle est dans la liste de `js/config.js`, sinon depuis la première de la liste.
- Politique de sécurité du contenu (`index.html`) : `default-src 'none'` ; scripts du widget et
  des instances listées ; requêtes réseau vers le widget lui-même (textes `i18n/*.json`) et ces
  instances ; styles et images du widget seulement ; aucun script ni style en ligne ;
  `base-uri` et `form-action` à `'none'` ; pas de référent envoyé.
- Toute requête réseau passe par `gristFetch` (`js/grist.js`), qui refuse une adresse hors des
  instances listées et n'envoie jamais de cookie (`credentials: 'omit'`).
- Aucun texte venu d'un document ou d'un code collé n'est inséré comme HTML : l'interface est
  construite avec des nœuds texte (`js/ui.js`, fonction `el`). Aucun `innerHTML`, `eval` ou
  `Function`. Les classes CSS ne viennent que du code (l'état d'une ligne d'historique est l'un de
  trois mots connus).
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
| `GET <document>/sql?q=select …` | lectures légères répétées (colonnes de `Synchro`, ligne de test d'un journal) | jeton court en lecture seule |
| `POST <instance>/api/s/<clé>/tables/<journal>/records?flat=1` | bouton « Tester le lien » : une ligne marquée d'un nombre au hasard | aucune (clé du formulaire) |
| `GET <document SOURCE>` | onglet Envoyer : le document est-il lisible par lien public ? | aucune (requête anonyme) |
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
  dans le webhook de l'autre côté.
- **Lecteurs du document SOURCE** : `Synchro` contient les valeurs des colonnes exportées. Un
  document qui cache des colonnes à certains lecteurs doit aussi leur cacher `Synchro`.
- **Mode lien public** : la SOURCE est partagée en lecture « toute personne ayant le lien », par
  son propriétaire. Le widget pose d'abord des règles d'accès, de mémo « Synchro : lecture limitée
  aux exports publics », placées avant les autres, pour `user.Access == VIEWER` : lecture refusée
  sur tout le document sauf, dans `Synchro`, les lignes `complet` et `empreinte` des exports
  publics, et sans la colonne `Synchro_Export`, dont la description porte la note de la SOURCE
  (sinon lisible par tous, vérifié). Conséquences : tout lecteur du document (pas seulement le lien
  public) ne voit plus que ces lignes, et les données des exports publics sont publiques. Les noms
  des tables des exports restent lisibles dans les formules de `Synchro`. Vérifié : sans
  identifiant, les tables d'origine répondent 403, la note n'est pas lisible, et `Synchro` ne
  montre que les lignes de l'export public.

## Codes d'invitation et de réponse

Ils sont faits pour être copiés dans un courriel : ce sont des **identifiants**, à transmettre à
la seule personne concernée.

- **Invitation** : identifiants de l'invitation et de l'export, nom de l'export, instance,
  e-mail de la personne qui l'a créée et identifiant du document SOURCE (affichés à la CIBLE avant
  d'accepter, et utiles pour refuser une boucle), tables et colonnes envoyées, et en option un
  secret aléatoire de 128 bits. En mode lien public : l'adresse REST du document, réécrite et
  contrôlée (même instance que la CIBLE). En Échange : l'adresse d'écriture du journal de retour,
  c'est-à-dire **une clé d'écriture**.
- **Réponse** : adresse d'écriture du journal de la CIBLE (**une clé d'écriture**), fiche du
  destinataire (e-mail calculé par le serveur Grist de la CIBLE, `user.Email`, identifiant du
  document, équipe, date), et le secret s'il y en a un.
- La SOURCE ne garde que l'empreinte SHA-256 du secret ; la CIBLE garde le secret dans la note de
  son journal, lisible par ses lecteurs, utile seulement tant que l'invitation est en attente.
- La fiche est **déclarative** : seul le secret prouve que la réponse vient de quelqu'un qui a
  reçu l'invitation. Sans secret, l'approbation repose sur la fiche, et le widget le signale.
- Contrôles à la lecture (`js/logic/codes.js`) : préfixe et version, identifiants, secret,
  colonnes (noms Grist, types connus, 400 au plus), textes coupés à 200 caractères, adresses de la
  forme exacte `/api/s/<clé>/tables/<table>/records?flat=1` sur la **même instance**, sans
  identifiant dans l'adresse, réécrites avant usage. La réponse doit porter le secret d'une
  invitation en attente de ce document.
- Une nouvelle invitation pour un export déjà reçu (lien coupé, destinataire révoqué) ne reprend
  la réception qu'après confirmation, fiche affichée, et seulement si elle vient du même document
  dans le même mode.

## La clé du formulaire de réception

- **Une clé par réception** : Grist donne une clé par page partagée, et cette clé lit aussi les
  colonnes des tables de tous les formulaires de la page, descriptions comprises (vérifié). Chaque
  journal a donc son formulaire sur sa propre page, à la racine de la liste des pages. Les formulaires
  publiés par une version d'avant la 0.5 sur une même page sont signalés (« Lien commun à
  d'autres formulaires ») avec un bouton qui les sépare.
- **Ce qu'elle permet** (vérifié) : ajouter des lignes au journal de sa réception ; lire les
  colonnes de ce journal et leurs descriptions (donc la note de la réception, dont le secret), et
  le nom et l'identifiant du document. Elle ne lit aucune ligne, ne modifie ni ne supprime rien,
  et n'atteint pas le journal d'une autre page (403 en écriture, 404 en lecture).
- **Qui la connaît** : la personne qui l'a copiée, les propriétaires de la SOURCE (réglages du
  webhook), et, en Échange, quiconque a vu le code d'invitation. Le widget ne l'écrit dans aucune
  table ni note, et la masque partout à l'écran, messages d'erreur de Grist compris
  (`…/api/s/Ab12…/…`).
- **Ce que la CIBLE accepte** : l'expéditeur fait foi pour le contenu de son export (versions,
  suppressions, colonnes ajoutées à l'export, tables proposées). Une table nouvelle n'est jamais
  rangée sans l'accord d'un éditeur ; une colonne nouvelle prend un nom libre dans la destination,
  jamais celui d'une colonne existante. Une ligne qui ne peut pas venir du webhook de cet export
  (autre export, type inconnu, contenu illisible, nom de table invalide) est effacée sans effet et
  comptée ; une arrivée anormale est signalée (« Arrivées suspectes ») avec un bouton pour couper
  le lien. Aucun nom reçu ne peut viser une propriété des objets JavaScript (`__proto__`…), et les
  volumes sont bornés (100 000 lignes par lot, 1 000 clés trop grosses et 200 tables suivies par
  journal, 500 lignes reçues par passage).
- **Fin d'un envoi** : quand la SOURCE révoque un destinataire, supprime l'export ou arrête un
  Échange, son widget envoie d'abord une ligne « fin » à l'adresse du webhook, puis l'efface ; la
  carte de la CIBLE affiche « Coupé par la SOURCE ». Qui a la clé peut forger cette ligne : la
  carte le dirait à tort, jusqu'aux données suivantes, qui effacent l'avis. Rien n'est supprimé.
- **Historique et valeurs retouchées** : la colonne `Sync_Avant` du journal garde, pour
  l'historique, les valeurs qu'une recopie a remplacées dans la destination (colonnes modifiées
  seulement) et le numéro d'une ligne supprimée. Ces valeurs restent dans le document, visibles de
  qui lit le journal comme les versions reçues ; la clé du formulaire ne lit pas les lignes, et la
  purge efface les versions remplacées. Qui a la clé peut écrire cette colonne : l'historique
  montrerait un « avant » faux, comme le ferait une version forgée ; rien n'est recopié depuis
  elle. Les valeurs retouchées à la main se calculent à l'affichage, sans rien écrire.
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
  un destinataire. `Synchro` est une table ordinaire : un **éditeur** de la SOURCE peut la
  modifier, par exemple la description des colonnes envoyées, et ainsi élargir ce que reçoivent
  les destinataires déjà branchés (il peut de toute façon lire et recopier ces données). Pour
  l'empêcher, une règle d'accès peut réserver l'écriture de `Synchro` aux propriétaires (le widget
  des éditeurs ne fait alors plus que lire).
- CIBLE : un **éditeur** accepte une invitation, range les tables et recopie ; un lecteur voit les
  cartes, boutons grisés. Un Échange demande un propriétaire.

## Ce que le widget écrit et garde

- Pas de table de réglages. Les destinataires branchés sont les webhooks eux-mêmes (le mémo garde
  la fiche), visibles par les propriétaires dans les paramètres du document.
- SOURCE : `id_sync` et `MajLe` dans chaque table envoyée (et la case `Supprime` en Échange), la
  table `Synchro`, et une note (exports, invitations en attente avec l'empreinte de leur secret,
  pauses) dans la description de `Synchro_Export`.
- CIBLE : les tables de destination (plus `id_sync`, masquée), un journal par export reçu avec sa
  note (destinations, colonnes, tables refusées, secret) dans la description de `Synchro_Ids`, et
  le formulaire de réception sur sa page.
- Un renvoi ne modifie jamais les tables de la personne : il n'écrit que dans `Synchro`.

## Chaîne d'approvisionnement

Le widget a un **accès complet** au document : qui peut modifier son code peut lire et écrire le
document de quiconque l'ouvre. Le risque n'est pas le transit des données mais l'origine du code.
Pour un usage en production :

- héberger une **copie figée** du dépôt (version relue, étiquette Git) sur un serveur de
  l'organisation, plutôt que la branche `main` sur GitHub Pages ;
- ajouter cette adresse à la liste des widgets de l'instance, et ne garder dans `js/config.js` et
  la politique de `index.html` que les instances Grist utilisées ;
- relire le code à chaque mise à jour : environ 3 500 lignes, sans dépendance.

## Ce que le widget ne fait pas

- Aucune requête vers un service tiers, aucune télémétrie, aucune donnée hors de Grist.
- Aucune clé d'API personnelle : seuls le jeton court du document et la clé du formulaire servent.
- Aucune lecture du document CIBLE depuis la SOURCE. La CIBLE ne lit la SOURCE qu'en mode lien
  public, sans identifiant, et seulement ce que les règles d'accès laissent voir.

## Risques acceptés

- L'expéditeur d'un export, ou qui a obtenu la clé de sa réception, peut écrire dans les tables de
  destination de cette réception ce que l'export pourrait y écrire (versions datées du futur,
  suppressions) : c'est le principe de la synchro. Couper le lien y met fin.
- Un envoi en échec bloque la file de tous les webhooks du document SOURCE environ 15 minutes
  (comportement de Grist) : un destinataire qui refuse ses envois retarde les autres. Le widget
  le signale et propose de débloquer la file.
- Sans Redis, la file d'envoi de Grist vit en mémoire : un redémarrage du serveur la perd (le
  widget renvoie ce qui manque à la prochaine ouverture par un propriétaire).
- Le paramètre `?flat=1` n'est pas documenté par Grist (couvert par ses tests depuis 2023).
