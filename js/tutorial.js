// Tutoriel intégré : le mode d'emploi pas à pas, avec les captures de docs/images. Affiché en entier dans l'onglet
// Tutoriel, et par morceaux (`stepHelp`) en bas des étapes des assistants.
import { LANG, t } from './i18n.js';
import { el, openModal } from './ui.js';

const IMG = name => (name.startsWith('img/') ? name : `docs/images/${name}.png`);

// role : 'source', 'target' ou 'both'. text : paragraphes, fr puis en.
// Les sections suivent le parcours réel, dans l'ordre où les deux personnes le vivent : chacune
// est aussi reprise seule comme aide d'une étape d'assistant (`stepHelp`), son `id` ne change donc
// pas.
const SECTIONS = [
  // Avant tout : installer le widget, des deux côtés.
  { id: 'install', role: 'both',
    title: ['Installer le widget (dans chaque document)', 'Install the widget (in each document)'],
    text: [[
      'Il faut un propriétaire du document SOURCE et un éditeur du document CIBLE, sur la même instance Grist. Chacun installe le widget dans son document :',
      '1. Ajouter, puis Ajouter une page.',
      '2. Choisir la vue Personnalisée, avec n’importe quelle table, puis Ajouter une page.',
      '3. Cliquer « URL personnalisée », coller l’adresse du widget (onglet Tutoriel, en bas), puis Ajouter un widget. Grist peut demander de confirmer que vous faites confiance au widget.',
      '4. Dans le panneau de droite, accepter l’accès complet au document. Renommer la page, par exemple « Synchro ». Les tables techniques n’ont pas de page : elles sont dans « Données source ».',
    ], [
      'You need an owner of the SOURCE document and an editor of the TARGET document, on the same Grist instance. Each installs the widget in their document:',
      '1. Add, then Add page.',
      '2. Pick the Custom view, with any table, then Add page.',
      '3. Click “Custom URL”, paste the widget address (Tutorial tab, at the bottom), then Add widget. Grist may ask you to confirm you trust the widget.',
      '4. In the right panel, accept full access to the document. Rename the page, for example “Sync”. Technical tables have no page: they are in “Raw data”.',
    ]],
    images: ['00a-installer-ajouter', '00b-installer-page', '00c-installer-url', '00d-installer-acces', '01-accueil'] },
  // SOURCE : créer un export (tables, colonnes, options), puis inviter.
  { id: 's-tables', role: 'source',
    title: ['Créer un export : les tables', 'Create an export: the tables'],
    text: [[
      'Un export a un nom, des tables et leurs colonnes ; on y ajoute ensuite les personnes qui le reçoivent. Envoyer, Nouvel export, cocher les tables.',
    ], [
      'An export has a name, tables and their columns; you then add the people who receive it. Send, New export, tick the tables.',
    ]],
    images: ['02-source-tables'] },
  { id: 's-columns', role: 'source',
    title: ['Choisir les colonnes, nommer l’export', 'Pick the columns, name the export'],
    text: [[
      'Cocher les colonnes qui partent (toutes par défaut). Le reste ne sort jamais du document. Les colonnes valent pour tous les destinataires de l’export.',
      'À la création, le widget ajoute id_sync (identifiant stable) et MajLe (date de modification) aux tables, et la table technique Synchro, une seule pour tout le document. Une colonne Supprime déjà présente est prise en compte : une ligne cochée est retirée de la CIBLE.',
    ], [
      'Tick the columns to send (all by default). The rest never leaves the document. Columns apply to all recipients of the export.',
      'On creation, the widget adds id_sync (stable key) and MajLe (last change) to the tables, and the Synchro technical table, one for the whole document. An existing Supprime column is honoured: a ticked row is removed from the TARGET.',
    ]],
    images: ['03-source-colonnes', '03b-source-nom'] },
  { id: 's-options', role: 'source',
    title: ['Ajouter un destinataire', 'Add a recipient'],
    text: [[
      'Sur la carte de l’export, Ajouter un destinataire. Mode « avec réponse » (recommandé) : Grist pousse chaque modification, même page fermée. Le secret garantit que la réponse vient de quelqu’un qui a reçu l’invitation. Deux autres modes : Échange (dans les deux sens) et Lien public, plus bas.',
    ], [
      'On the export card, Add a recipient. “With reply” mode (recommended): Grist pushes every change, even with the page closed. The secret guarantees the reply comes from someone who received the invitation. Two other modes: Exchange (both ways) and Public link, below.',
    ]],
    images: ['04-source-options'] },
  { id: 's-invite', role: 'source',
    title: ['Transmettre l’invitation', 'Send the invitation'],
    text: [[
      'Copier le code, ou « Copier avec les consignes » pour un message prêt à envoyer par courriel à la personne de la CIBLE. « Plus tard » ferme l’assistant : l’invitation attend sur la carte de l’export.',
    ], [
      'Copy the code, or “Copy with instructions” for a message ready to email to the TARGET person. “Later” closes the wizard: the invitation waits on the export card.',
    ]],
    images: ['05-source-invitation', '06-source-attente'] },
  // CIBLE : accepter l'invitation, ranger les tables, donner le lien du formulaire.
  { id: 't-code', role: 'target',
    title: ['Coller le code d’invitation', 'Paste the invitation code'],
    text: [['Recevoir, Accepter une invitation, coller le code reçu de la SOURCE.'], ['Receive, Accept an invitation, paste the code received from the SOURCE.']],
    images: ['07-cible-code'] },
  { id: 't-dest', role: 'target',
    title: ['Choisir les destinations', 'Pick the destinations'],
    text: [[
      'Pour chaque table de l’export : Nouvelle table (nom modifiable) ou une table du document.',
      'Pour une table existante, dire où va chaque colonne et par quelle colonne rattacher les lignes déjà là : une ligne dont cette colonne a la même valeur est mise à jour au lieu d’être doublée.',
      'Le widget crée un journal pour l’export et publie son formulaire de réception sur sa propre page, en bas de la liste des pages.',
    ], [
      'For each table of the export: New table (name editable) or a table of the document.',
      'For an existing table, say where each column goes and which column attaches rows already there: a row with the same value is updated instead of duplicated.',
      'The widget creates a journal for the export and publishes its receiving form on its own page, at the bottom of the page list.',
    ]],
    images: ['08-cible-destinations', '08b-cible-colonnes'] },
  { id: 't-link', role: 'target',
    title: ['Copier le lien du formulaire', 'Copy the form link'],
    text: [[
      'Ouvrir la page du formulaire, en bas de la liste des pages, puis dans sa carte : Partager, Copier le lien. Coller ce lien dans le widget, Tester le lien : le widget vérifie qu’il écrit bien dans le journal de cette réception. Il sert pour toutes les tables de l’export, et pour celles qui s’y ajouteront.',
      'Ce lien est un droit d’écriture dans votre journal : ne le diffusez pas ailleurs. Chaque réception a le sien.',
    ], [
      'Open the form’s page, at the bottom of the page list, then in its card: Share, Copy link. Paste it in the widget, Test the link: the widget checks that it writes into this reception’s journal. It works for every table of the export, and those added later.',
      'This link is a write right into your journal: do not share it elsewhere. Each reception has its own.',
    ]],
    images: ['img/aide-partager.png', 'img/aide-copier.png', '09-cible-lien'] },
  { id: 't-reply', role: 'target',
    title: ['Renvoyer la réponse', 'Send the reply back'],
    text: [[
      'Copier le code de réponse, ou « Copier avec les consignes », et l’envoyer à la SOURCE. Il contient l’adresse d’écriture et votre fiche (e-mail, document, équipe), pas de données.',
    ], [
      'Copy the reply code, or “Copy with instructions”, and send it to the SOURCE. It holds the write address and your card (email, document, team), no data.',
    ]],
    images: ['10-cible-reponse'] },
  // SOURCE : approuver la réponse, envoyer l'existant, gérer les destinataires.
  { id: 's-reply', role: 'source',
    title: ['Approuver la réponse', 'Approve the reply'],
    text: [[
      'Sur la carte de l’export, ligne de l’invitation, Coller la réponse. Vérifier qui a accepté, puis Approuver et brancher : Grist reçoit un webhook filtré sur cet export, la personne ne reçoit que ses lignes.',
    ], [
      'On the export card, invitation line, Paste the reply. Check who accepted, then Approve and connect: Grist gets a webhook filtered on this export, the person only receives its rows.',
    ]],
    images: ['11-source-fiche'] },
  { id: 's-load', role: 'source',
    title: ['Envoyer les lignes existantes', 'Send the existing rows'],
    text: [['Le branchement n’envoie que les changements à venir : Envoyer pousse les lignes déjà là.'], ['Connecting only sends future changes: Send pushes the rows already there.']],
    images: ['12-source-envoi'] },
  { id: 's-manage', role: 'source',
    title: ['Gérer un export', 'Manage an export'],
    text: [[
      'La carte de l’export liste ses tables et ses destinataires. Pour l’export : Ajouter un destinataire (sans refaire l’export) ; Modifier (tables, colonnes, nom, pour tous) ; Tout renvoyer ; Supprimer.',
      'Pour une personne : Mettre en pause, puis Reprendre, qui propose de rattraper les changements de la pause (recommandé) ; Débloquer la file si un envoi échoue ; Révoquer, sans toucher aux autres.',
      'Un renvoi part vers tous les destinataires de l’export ; chez ceux qui avaient déjà ces lignes, il est sans effet.',
    ], [
      'The export card lists its tables and recipients. For the export: Add a recipient (without redoing the export); Edit (tables, columns, name, for everyone); Resend all; Delete.',
      'For one person: Pause, then Resume, which offers to catch up on changes made during the pause (recommended); Unblock the queue when a delivery fails; Revoke, without affecting the others.',
      'A resend goes to all recipients of the export; for those who already had these rows, it has no effect.',
    ]],
    images: ['13-source-actif', '18-source-modifier', '13b-source-reprendre'] },
  // CIBLE au quotidien : la recopie, les tables ajoutées plus tard.
  { id: 't-daily', role: 'target',
    title: ['Au quotidien, côté CIBLE', 'Day to day, TARGET side'],
    text: [[
      'Chaque changement de la SOURCE arrive dans le journal en une seconde environ, même page fermée. La recopie dans vos tables se fait quand un éditeur ouvre la page du widget (même replié), puis toutes les 10 secondes.',
      'L’historique montre, par table, les lignes ajoutées, modifiées et supprimées depuis votre dernière visite, nommées par la colonne de votre choix.',
      'Une retouche faite à la main reste en place jusqu’à la prochaine modification de la même ligne dans la SOURCE. Arrêter la réception efface le journal et garde vos tables.',
    ], [
      'Each SOURCE change reaches the journal in about a second, even with the page closed. Copying into your tables happens when an editor opens the widget page (even collapsed), then every 10 seconds.',
      'The history shows, per table, the rows added, changed and deleted since your last visit, named by the column of your choice.',
      'A manual edit stays until the same row changes again in the SOURCE. Stop receiving deletes the journal and keeps your tables.',
    ]],
    images: ['14-cible-historique'] },
  { id: 't-offer', role: 'target',
    title: ['Une table ajoutée à l’export', 'A table added to the export'],
    text: [[
      'Quand la SOURCE ajoute une table à l’export, une fenêtre demande où la ranger : Recevoir (nouvelle table, ou table existante avec la correspondance des colonnes), Refuser (ses lignes sont effacées à l’arrivée), ou Plus tard (elle reste proposée sur la carte).',
    ], [
      'When the SOURCE adds a table to the export, a dialog asks where it goes: Receive (new table, or existing table with column mapping), Refuse (its rows are deleted on arrival), or Later (it stays offered on the card).',
    ]],
    images: ['17-cible-nouvelle-table', '08b-cible-colonnes'] },
  // Cas particuliers (grosses tables, Échange, lien public, relais), puis les pannes connues.
  { id: 'big', role: 'both',
    title: ['Gros changements, valeurs venues d’une autre table', 'Big changes, values from another table'],
    text: [[
      'Un changement de plus de 2 000 lignes environ, fait d’un coup (import, remplacement), ne part qu’en partie. Grist le note dans la table Synchro, et le widget SOURCE envoie le reste par tranches, seul, dès qu’un propriétaire ouvre sa page (même repliée). En attendant, la CIBLE affiche combien de lignes manquent.',
      'Une valeur qui change à cause d’une autre table (le nom d’une ville renommée, affiché par une Référence, ou une formule) repart seule, sans toucher la ligne.',
      'Une grande table part comme une petite : la liste de ses clés tient en 256 empreintes, et le widget envoie la liste complète par morceaux quand il le faut. Si des envois en attente dépassent ensemble la taille permise par Grist, le widget SOURCE vide la file et renvoie tout, seul.',
    ], [
      'A change of more than about 2,000 rows made at once (import, replace) is only partly sent. Grist notes it in the Synchro table, and the SOURCE widget sends the rest in batches, on its own, as soon as an owner opens its page (even collapsed). Meanwhile, the TARGET shows how many rows are missing.',
      'A value that changes because of another table (the name of a renamed city, shown by a Reference, or a formula) leaves on its own, without touching the row.',
      'A large table leaves like a small one: its key list fits in 256 fingerprints, and the widget sends the full list in parts when needed. If waiting deliveries together exceed the size Grist allows, the SOURCE widget clears the queue and resends everything, on its own.',
    ]],
    images: ['19-cible-envoi-coupe'] },
  { id: 'exchange', role: 'both',
    title: ['Variante : Échange, dans les deux sens', 'Variant: Exchange, both ways'],
    text: [[
      'Deux documents se tiennent à jour l’un l’autre : une modification faite d’un côté passe de l’autre, sans revenir ; quand la même ligne change des deux côtés, la plus récente l’emporte. Il faut un propriétaire de chaque côté.',
      'SOURCE : en ajoutant un destinataire (le premier de l’export), choisir Échange. Le widget publie un formulaire de retour sur sa propre page : copier son lien, il part dans l’invitation. CIBLE : accepter comme d’habitude ; la réponse branche les deux sens à la fois. SOURCE : approuver.',
      'Une case Supprime est ajoutée aux tables : cochée d’un côté, la ligne disparaît des deux. Arrêter, d’un côté ou de l’autre, arrête les deux sens ; les tables gardent leurs lignes.',
    ], [
      'Two documents keep each other up to date: a change made on one side reaches the other, without coming back; when the same row changes on both sides, the most recent wins. Each side needs an owner.',
      'SOURCE: when adding a recipient (the first of the export), pick Exchange. The widget publishes a return form on its own page: copy its link, it goes into the invitation. TARGET: accept as usual; the reply connects both ways at once. SOURCE: approve.',
      'A Supprime box is added to the tables: ticked on one side, the row disappears on both. Stopping, on either side, stops both ways; the tables keep their rows.',
    ]],
    images: ['20-echange-mode', '21-echange-cible'] },
  { id: 'public', role: 'both',
    title: ['Variante : lien public', 'Variant: public link'],
    text: [[
      'SOURCE : en ajoutant un destinataire, choisir Lien public. Le widget pose des règles d’accès : un lecteur du document, dont le lien public, ne voit plus que les exports publics. Puis, dans Partager, régler « Lien public » sur Lecture.',
      'CIBLE : coller le code, choisir les destinations, c’est tout. Le widget lit la SOURCE toutes les 10 secondes tant que sa page est ouverte. À éviter pour des données qui ne doivent pas être publiques.',
    ], [
      'SOURCE: when adding a recipient, pick Public link. The widget adds access rules: a viewer of the document, including the public link, only sees the public exports. Then, in Share, set “Public link” to Viewer.',
      'TARGET: paste the code, pick the destinations, that is all. The widget reads the SOURCE every 10 seconds while its page is open. Avoid for data that must not be public.',
    ]],
    images: ['15-source-public'] },
  { id: 'relay', role: 'both',
    title: ['Envoyer et recevoir dans le même document, relais', 'Send and receive in the same document, relay'],
    text: [[
      'Un document peut envoyer certaines tables et en recevoir d’autres : les deux onglets fonctionnent ensemble.',
      'Une table reçue peut être relayée vers un troisième document (A vers B vers C). Le second saut part quand un éditeur ouvre la page du widget de B. Une ligne ajoutée à la main dans la table relayée reste dans B.',
      'Le widget refuse les boucles : renvoyer une table reçue au document d’où elle vient, ou une table vers elle-même.',
    ], [
      'A document can send some tables and receive others: both tabs work together.',
      'A received table can be relayed to a third document (A to B to C). The second hop leaves when an editor opens the widget page of B. A row added by hand in the relayed table stays in B.',
      'The widget refuses loops: sending a received table back to the document it comes from, or a table to itself.',
    ]],
    images: [] },
  { id: 'trouble', role: 'both',
    title: ['Si quelque chose coince', 'If something gets stuck'],
    text: [[
      'Rien n’arrive dans la table de la CIBLE : ouvrir la page du widget dans la CIBLE, les versions attendaient dans le journal.',
      'Ligne d’un destinataire en rouge : la CIBLE a arrêté la réception, coupé ou dépublié son formulaire. Révoquer cette personne, puis l’inviter de nouveau ; dans la CIBLE, la même réception reprend.',
      'Tous les envois du document SOURCE sont en retard : un envoi en échec bloque la file. Débloquer la file.',
      'Des lignes ne sont pas arrivées : ouvrir la page du widget dans la SOURCE (un gros changement y finit de partir seul), sinon Tout renvoyer.',
      'Au branchement, « Grist 1.7.11 ou plus récent » : l’instance ne sait pas filtrer un webhook par export.',
    ], [
      'Nothing reaches the TARGET table: open the widget page in the TARGET, versions were waiting in the journal.',
      'Red recipient line: the TARGET stopped receiving, cut or unpublished its form. Revoke this person, then invite them again; in the TARGET, the same reception resumes.',
      'All deliveries of the SOURCE document are late: a failed delivery blocks the queue. Unblock the queue.',
      'Rows did not arrive: open the widget page in the SOURCE (a big change finishes leaving there on its own), otherwise Resend all.',
      'On connecting, “Grist 1.7.11 or later”: the instance cannot filter a webhook by export.',
    ]],
    images: [] },
];

const pick = pair => pair[LANG === 'en' ? 1 : 0];

// Une capture, agrandie au clic dans une fenêtre.
function figure(name) {
  const img = el('img', { src: IMG(name), alt: '', loading: 'lazy' });
  return el('button', { class: 'tuto-shot', type: 'button', 'aria-label': t('tuto.zoom'),
    onclick: () => openModal({ title: t('tuto.zoom'), width: 'full', body: el('img', { class: 'tuto-full', src: IMG(name), alt: '' }),
      buttons: [{ label: t('common.close'), kind: 'btn-primary' }] }) }, img);
}

function section(s, number) {
  return el('section', { class: 'tuto-section', id: `tuto-${s.id}`, 'data-role': s.role },
    el('h2', {}, number ? `${number}. ` : '', pick(s.title),
      s.role === 'both' ? null : el('span', { class: `role-badge role-${s.role}` }, t(`guide.role.${s.role}`))),
    pick(s.text).map(p => el('p', {}, p)),
    s.images.length ? el('div', { class: 'tuto-shots' }, s.images.map(figure)) : null);
}

// Onglet Tutoriel : tout le parcours, filtrable par rôle.
export function tutorialView(address) {
  const sections = SECTIONS.map((s, i) => section(s, i + 1));
  const filter = role => {
    for (const node of sections) node.classList.toggle('hidden', role !== 'all' && !['both', role].includes(node.dataset.role));
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.role === role));
  };
  const buttons = [['all', t('tuto.all')], ['source', t('tuto.source')], ['target', t('tuto.target')]].map(([role, label]) =>
    el('button', { class: 'btn btn-small', type: 'button', 'data-role': role, 'aria-pressed': String(role === 'all'), onclick: () => filter(role) }, label));
  return el('div', { class: 'tuto' },
    el('h2', { class: 'home-title' }, t('tuto.title')),
    el('p', { class: 'muted' }, t('tuto.intro')),
    el('div', { class: 'tuto-filter', role: 'group', 'aria-label': t('tuto.filter') }, buttons),
    sections,
    address);
}

// Aide en images pour une étape d'assistant : les sections `ids`, repliées.
export function stepHelp(ids) {
  const chosen = SECTIONS.filter(s => ids.includes(s.id));
  return el('details', { class: 'guide tuto-step' }, el('summary', {}, t('tuto.step')), chosen.map(s => section(s)));
}
