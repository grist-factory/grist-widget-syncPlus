// SOURCE : ce qu'un export dit des colonnes de ses tables qui ont changé depuis son enregistrement (renommée sans doute, autre type, affichage
// changé) et des colonnes ajoutées depuis, qui ne partent pas (voir engine/logic/new-columns.js). Les boutons viennent de l'onglet, qui sait
// les rendre inactifs pour qui n'est pas propriétaire et redessiner la carte.
import { el, message, notice } from '../ui.js';
import { t, typeName } from '../i18n.js';

// Une ligne par colonne qui a changé. Sans détail (un export dont la SOURCE ne dit rien de plus), le texte général d'avant.
function driftLine(d) {
  const vars = { table: d.table, col: d.id, to: d.to || '', was: d.was ? typeName(d.was) : '', now: d.now ? typeName(d.now) : '' };
  const key = { gone: d.to ? 'send.drift.renamed' : 'send.drift.gone', retyped: 'send.drift.retyped', shown: 'send.drift.shown' }[d.kind];
  return key ? t(key, vars) : '';
}

export function driftNotice(exp) {
  if (!exp.details.length) return exp.changed.length ? message('warn', t('send.export.drift', { cols: exp.changed.join(', ') })) : null;
  return notice({
    tone: 'warn', title: t('send.drift.title', { n: exp.details.length }), lines: [t('send.drift.body')], className: 'drift', 'data-drift': exp.id,
    body: [el('ul', { class: 'small' }, ...exp.details.map(d => el('li', {}, driftLine(d))))],
  });
}

// `actions` : { send, dismiss }, les deux boutons.
export function newColumnsNotice(exp, actions) {
  if (!exp.fresh.length) return null;
  const n = exp.fresh.reduce((sum, f) => sum + f.columns.length, 0);
  return notice({
    tone: 'info', title: t('send.new.title', { n }), lines: [t('send.new.body')], className: 'new-columns', 'data-new-columns': exp.id,
    body: [el('ul', { class: 'small' }, ...exp.fresh.map(f => el('li', {}, t('send.new.line', { table: f.table, cols: f.columns.map(c => c.id).join(', ') }))))],
    actions: [actions.send, actions.dismiss],
  });
}
