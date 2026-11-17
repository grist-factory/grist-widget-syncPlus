// SOURCE : les deux fenêtres qui remettent la table Synchro en état (voir logic/strays.js) :
//  - retirer les colonnes qui ne sont pas au widget (un envoi les emporte, le journal du destinataire
//    les refuse) ;
//  - rendre son nom à Synchro quand une table de ce nom n'est pas celle du widget.
// Ni l'une ni l'autre n'efface rien sans que la personne l'ait lu : le texte dit ce que contiennent
// les colonnes, et demande de sauvegarder avant.
import { SYNC_TABLE } from '../engine/logic/common.js';
import { freeTableName, hasContent, tableNameProblem } from '../engine/logic/strays.js';
import { fetchRows, readSchema } from '../grist.js';
import { removeStrayColumns, renameForeignSync } from '../engine/source/synchro.js';
import { clearAndMark } from '../engine/source/resend.js';
import { el, message, openModal, run } from '../ui.js';
import { t, typeName } from '../i18n.js';

const columnLine = (stray) => {
  const col = stray.label && stray.label !== stray.id ? `${stray.label} (${stray.id})` : stray.id;
  const vars = { col, type: typeName(stray.type), n: stray.filled, formula: stray.formula };
  const key = stray.filled ? 'send.stray.col.filled' : stray.formula ? 'send.stray.col.formula' : 'send.stray.col.empty';
  return el('li', {}, t(key, vars));
};

// Fenêtre « Retirer les colonnes en trop ». `stuck` : un envoi est bloqué par l'une d'elles, la file
// de Grist garde alors ses envois (qui portent la colonne) : elle est vidée après le retrait, et le
// widget renvoie les exports. Rend vrai si les colonnes ont été retirées.
export function strayDialog(strays, { stuck = false } = {}) {
  const risky = strays.some(hasContent);
  const sure = el('input', { type: 'checkbox', onchange: () => modal.setButtons(buttons()) });
  const report = el('div', { class: 'report' });
  let removed = false;
  let resolveDialog;
  const done = new Promise((resolve) => { resolveDialog = resolve; });
  const buttons = () => [
    { label: t('common.later') },
    {
      label: t('send.stray.remove'), kind: 'btn-danger', disabled: risky && !sure.checked,
      onClick: m => run(null, report, async () => {
        await removeStrayColumns(strays.map(s => s.id));
        if (stuck) await clearAndMark();
        removed = true;
        m.close();
      }),
    },
  ];
  const modal = openModal({
    title: t('send.stray.dialog.title'),
    body: el('div', { class: 'form' },
      el('p', {}, t('send.stray.dialog.intro', { n: strays.length })),
      el('ul', { class: 'stray-list' }, strays.map(columnLine)),
      risky ? message('warn', t('send.stray.save', { n: strays.filter(hasContent).length, cols: strays.filter(hasContent).map(s => s.id).join(', ') })) : el('p', { class: 'small' }, t('send.stray.empty', { n: strays.length })),
      risky ? el('label', { class: 'check' }, sure, t('send.stray.sure')) : null,
      stuck ? el('p', { class: 'muted small' }, t('send.stray.unblock')) : null,
      report),
    buttons: buttons(),
    onClose: () => resolveDialog(removed),
  });
  return done;
}

// Fenêtre « Une table Synchro existe déjà » : la table de ce nom n'est pas celle du widget. Elle est
// renommée (le nom est proposé, modifiable) ; ses colonnes, ses valeurs et ses formules restent.
// Rend vrai si elle l'a été.
export async function foreignDialog() {
  const schema = await readSchema();
  const taken = schema.tableIds;
  const cols = schema.columns(SYNC_TABLE).map(c => c.colId).filter(id => id !== 'manualSort');
  const rows = (await fetchRows(SYNC_TABLE)).length;
  const name = el('input', { type: 'text', class: 'input', id: 'gristsync-foreign-name', value: freeTableName(taken), spellcheck: 'false' });
  const report = el('div', { class: 'report' });
  let renamed = false;
  let resolveDialog;
  const done = new Promise((resolve) => { resolveDialog = resolve; });
  openModal({
    title: t('send.foreign.title'),
    body: el('div', { class: 'form' },
      el('p', {}, t('send.foreign.body')),
      el('p', { class: 'muted small' }, t('send.foreign.facts', { c: cols.length, cols: cols.slice(0, 8).join(', ') + (cols.length > 8 ? '…' : ''), n: rows })),
      el('p', {}, t('send.foreign.how')),
      el('label', { for: 'gristsync-foreign-name' }, t('send.foreign.name')),
      name,
      report),
    buttons: [
      { label: t('common.later') },
      {
        label: t('send.foreign.rename'), kind: 'btn-primary',
        onClick: m => run(null, report, async () => {
          const problem = tableNameProblem(name.value, taken);
          if (problem === 'empty') throw new Error('tableNameEmpty');
          if (problem === 'invalid') throw new Error('tableNameInvalid');
          if (problem === 'taken') throw new Error('tableNameTaken');
          await renameForeignSync(name.value.trim());
          renamed = true;
          m.close();
        }),
      },
    ],
    onClose: () => resolveDialog(renamed),
  });
  return done;
}
