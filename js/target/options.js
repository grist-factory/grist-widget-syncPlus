// Options d'une réception (hors Échange), choisies à l'acceptation et changeables sur sa carte :
//  - archive : une ligne effacée à la SOURCE reste ici, cochée « Supprimée à la source » (voir
//    planConsolidation) ;
//  - auto : les colonnes que la SOURCE ajoute à l'export sont créées ici toutes seules (décochée pour une réception
//    nouvelle : la carte les propose et attend un clic, voir engine/logic/structure.js ; cochée pour une réception
//    d'avant, qui n'a jamais demandé) ; la note garde `ask` quand la case est décochée ;
//  - verrou : les tables reçues sont en lecture seule pour tous sauf les propriétaires (règle
//    posée par un propriétaire, voir acl.js) ; la recopie attend alors qu'un propriétaire ouvre
//    la page. Seul un propriétaire change ce réglage sur la carte, et seul un propriétaire retire la
//    règle (`release` de syncRules) : une note réécrite par un éditeur est remise d'accord avec la
//    règle au passage suivant d'un propriétaire.
import { syncRules } from '../engine/acl.js';
import { updateJournalNote } from '../engine/target/journals.js';
import { optionsNote } from '../engine/logic/received.js';
import { cancelButton, el, openModal, run, withHelp } from '../ui.js';
import { t } from '../i18n.js';

// Les cases, cochées selon `current` ; `lockable` : la personne peut changer le verrou ;
// `change` : réception déjà en place (des lignes peuvent déjà être archivées).
export function receptionOptions(current, { lockable = true, change = false } = {}) {
  const archive = el('input', { type: 'checkbox', checked: Boolean(current.archive) });
  const verrou = el('input', { type: 'checkbox', checked: Boolean(current.verrou), disabled: !lockable });
  const auto = el('input', { type: 'checkbox', checked: !current.ask });
  return {
    node: el('div', { class: 'form' },
      withHelp(el('label', { class: 'check' }, auto, t('recv.structure.auto.option')), t('recv.structure.auto.help'), t('recv.structure.auto.option')),
      withHelp(el('label', { class: 'check' }, archive, t('recv.archive')), [t('recv.archive.help'), change ? t('recv.archive.off') : null].filter(Boolean), t('recv.archive')),
      withHelp(el('label', { class: 'check' }, verrou, t('recv.lock')), [t('recv.lock.help'), t('recv.lock.limit')], t('recv.lock')),
      lockable ? null : el('p', { class: 'muted small' }, t('recv.lock.ownerOnly'))),
    read: () => ({ archive: archive.checked, verrou: verrou.checked, ask: !auto.checked }),
  };
}

// Fenêtre « Options » d'une réception. Le dessin qui suit pose ou retire la règle du verrou (un
// propriétaire) ; le passage suivant ajoute la case d'archive aux destinations.
export function optionsDialog(group, owner, render) {
  const { note } = group;
  const options = receptionOptions(note, { lockable: owner, change: true });
  const report = el('div', { class: 'report' });
  const save = async (m) => {
    const { archive, verrou, ask } = options.read();
    // Seul un propriétaire lève la lecture seule : la règle en place ne part pas avec la note, que
    // d'autres peuvent réécrire (voir lockedTables).
    const release = owner && note.verrou && !verrou ? note.tables.map(tb => tb.dest) : [];
    await updateJournalNote(group.journal, ({ archive: a, verrou: v, ask: k, ...rest }) => ({ ...rest, ...optionsNote({ archive, verrou: owner ? verrou : v, ask }) }));
    m.close();
    if (release.length) await syncRules({ release });
    await render();
  };
  const initial = JSON.stringify(options.read());
  const saveHere = m => run(null, report, () => save(m));
  openModal({
    title: t('recv.options.title', { name: note.name }), width: 480,
    body: [options.node, report],
    // Échap ou la croix après un changement : enregistrer ou abandonner (voir openModal).
    guard: { save: saveHere, changed: () => JSON.stringify(options.read()) !== initial },
    buttons: [cancelButton(), { label: t('common.save'), kind: 'btn-primary', onClick: saveHere }],
  });
}
