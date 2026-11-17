// Étape « Contenu » de l'assistant d'export, partie Références : les colonnes Référence et Liste de références (voir
// engine/logic/links.js), chacune rangée dans la fiche de sa table. Pour chacune, on n'envoie que le texte affiché ou on garde
// le lien ; garder le lien ajoute la table visée à l'export, et le panneau de cette table s'ouvre juste sous le choix cliqué
// (sa colonne affichée seule, toute la table ou des colonnes au choix : voir pull.js). Hors Échange, où les colonnes vont dans
// les deux sens par leur nom.
import { exportableColumns } from '../engine/logic/exports.js';
import { linkOffers } from '../engine/logic/links.js';
import { checkList, el, withHelp } from '../ui.js';
import { filterEditor, filterSummary } from './filter-editor.js';
import { PULL_MODES, extrasFor, pullColumns, pullLeftOut } from './pull.js';
import { columnLabel, togglePart } from './export-parts.js';
import { t, typeName } from '../i18n.js';

// Ce que la personne décide pour chaque colonne Référence ou Liste de références cochée (voir linkOffers), à
// l'état de la fenêtre : les choix faits, ceux de l'export enregistré, sinon le lien est gardé quand la table visée est
// cochée. Les colonnes d'une table ajoutée pour un lien sont celles que le lien affiche et celles que la personne y prend
// (toute la table, ou celles qu'elle y coche : voir pull.js).
const pullMode = (ctx, table) => ctx.pulls.get(table) || 'shown';
export const pulledColumns = (ctx, schema, table, required = []) => pullColumns({
  mode: pullMode(ctx, table), usable: exportableColumns(schema.columns(table) || []), required, extras: [...(ctx.extras.get(table) || [])],
});
export const offersOf = (ctx, schema) => linkOffers({
  chosen: ctx.chosen, columnsOf: table => exportableColumns(schema.columns(table) || []),
  picked: table => (ctx.chosen.includes(table) ? ctx.selected.get(table) : pulledColumns(ctx, schema, table)),
  choices: ctx.choices, saved: ctx.saved,
});

// Panneau d'une table ajoutée pour un lien. Trois choix (voir pull.js) : la seule colonne que la Référence affiche (d'emblée), toute la
// table, ou les colonnes que la personne coche (la colonne affichée reste verrouillée). Ses lignes peuvent se filtrer comme celles
// des autres tables. Rend le panneau et son `slot`, où viennent les Références de cette table (en cascade).
function pulledBlock(ctx, schema, { table, required, onChange }) {
  const usable = exportableColumns(schema.columns(table) || []);
  const mode = () => pullMode(ctx, table);
  const picked = () => pulledColumns(ctx, schema, table, required);
  const labels = ids => usable.filter(c => ids.includes(c.id)).map(c => c.label);
  const summary = el('p', { class: 'small' });
  const leftOut = el('p', { class: 'muted small' });
  const describe = () => {
    const rows = filterSummary(ctx.filters.get(table));
    const names = mode() === 'all' ? t('send.refs.summary.whole') : labels(picked()).join(', ');
    summary.textContent = `${t('send.columns.some', { n: picked().length, total: usable.length })} (${names}) · ${rows ? t('send.rows.filtered', { filter: rows }) : t('send.rows.all')}`;
    const files = pullLeftOut({ mode: mode(), usable }).map(c => c.label);
    leftOut.textContent = files.length ? t('send.refs.mode.files', { cols: files.join(', ') }) : '';
    leftOut.classList.toggle('hidden', !files.length);
  };
  const columns = el('div', { class: 'form' });
  const drawColumns = () => {
    columns.replaceChildren(checkList({
      items: usable.map(c => ({ value: c.id, label: columnLabel(c), hint: typeName(c.source), keywords: typeName(c.source), locked: required.includes(c.id) })), wide: true,
      checked: picked(), label: table, onChange: (values) => { ctx.extras.set(table, values.filter(v => !required.includes(v))); describe(); onChange(); },
    }));
    columns.classList.toggle('hidden', mode() !== 'pick');
  };
  const choose = (next) => {
    // De « toute la table » à « choisir » : ce qui partait reste coché, pour pouvoir y retirer des colonnes.
    if (next === 'pick' && mode() !== 'pick') ctx.extras.set(table, extrasFor({ usable, required, columns: picked() }));
    ctx.pulls.set(table, next);
    drawColumns();
    describe();
    onChange();
  };
  const name = `gristsync-pull-${table}`;
  const texts = {
    shown: t('send.refs.mode.shown', { cols: labels(required).join(', ') }),
    all: t('send.refs.mode.all', { n: usable.filter(c => !pullLeftOut({ mode: 'all', usable }).includes(c)).length }),
    pick: t('send.refs.mode.pick'),
  };
  const modes = el('div', { class: 'radios pull-modes', role: 'radiogroup', 'aria-label': t('send.refs.mode', { table }) },
    PULL_MODES.map(value => el('label', { class: 'check' },
      el('input', { type: 'radio', name, value, checked: mode() === value, onchange: () => choose(value) }), el('span', {}, texts[value]))));
  const editor = filterEditor({ table, columns: usable, current: ctx.filters.get(table), labelOf: columnLabel, onChange: (filter) => { ctx.filters.set(table, filter); describe(); } });
  const filtered = Boolean(filterSummary(ctx.filters.get(table)));
  if (filtered) editor.load();
  drawColumns();
  describe();
  const slot = el('div', { class: 'ref-slot' });
  return {
    slot,
    node: el('div', { class: 'form table-block table-added', 'data-pulled': table },
      el('div', { class: 'added-head' }, el('h3', {}, table), el('span', { class: 'pill pill-ok' }, t('send.refs.added'))),
      el('p', { class: 'field-title' }, t('send.refs.mode', { table })), modes, summary, leftOut,
      el('div', { class: 'block-actions' }, togglePart(editor.node, t('send.rows.pick'), filtered, editor.load)),
      columns, editor.node, slot),
  };
}

// Une colonne Référence : son nom, ce qu'elle vise, deux choix empilés (« Envoyer seulement le texte » / « Garder le lien »), chacun
// avec ce qu'il fait, et dessous `panel`, où vient la table ajoutée. `update` la remet à l'état des choix sans la redessiner (le
// focus reste sur le bouton radio). `by` : la colonne sous laquelle la table visée est déjà ajoutée, quand c'est une autre.
function refRow(ctx, offer, onPick) {
  const id = `gristsync-ref-${offer.key}`.replace(/[^A-Za-z0-9_-]/g, '_');
  const kind = t(offer.list ? 'type.RefList' : 'type.Ref');
  const choice = (link, labelKey) => {
    const slug = link ? 'keep' : 'text';
    const what = el('span', { class: 'what', id: `${id}-${slug}` }, t(labelKey));
    const why = el('span', { class: 'why', id: `${id}-${slug}-why` });
    const input = el('input', { type: 'radio', name: `gristsync-ref-${offer.key}`, checked: false, 'aria-labelledby': `${id}-${slug}`, 'aria-describedby': `${id}-${slug}-why`,
      onchange: () => { ctx.choices.set(offer.key, link); onPick(); } });
    return { input, why, node: el('label', { class: 'choice' }, input, what, why) };
  };
  const text = choice(false, 'send.refs.values');
  const keep = choice(true, 'send.refs.link');
  text.why.textContent = t('send.refs.note.values');
  const keepWhy = (now, by) => {
    const vars = { target: now.target, shown: now.shown, kind, by };
    if (!now.ok) return t(`send.refs.note.${now.why}`, vars);
    if (now.inside) return t('send.refs.note.inside', vars);
    return t(now.link && by ? 'send.refs.already' : 'send.refs.link.why', vars);
  };
  const update = (now, by = '') => {
    text.input.checked = !now.link;
    keep.input.checked = now.link;
    keep.input.disabled = !now.ok;
    keep.why.textContent = keepWhy(now, by);
  };
  update(offer);
  const panel = el('div', { class: 'ref-panel' });
  const name = `${offer.table}.${offer.label}`;
  return {
    update, panel,
    node: el('div', { class: 'ref-item', 'data-ref': offer.key },
      withHelp(el('div', { class: 'col' }, el('strong', {}, offer.label), el('span', { class: 'pill pill-off' }, kind),
        el('span', { class: 'muted small' }, t('send.refs.aim', { target: offer.target, shown: offer.shown || '—' }))), t('send.refs.help'), offer.label),
      el('div', { class: 'choices', role: 'radiogroup', 'aria-label': name }, text.node, keep.node), panel),
  };
}

// Remplace les enfants de `parent` seulement s'ils diffèrent : un nœud déplacé perd le focus, un redessin sans changement ne doit pas toucher à la page.
function setChildren(parent, nodes) {
  const same = parent.children.length === nodes.length && nodes.every((node, i) => parent.children[i] === node);
  if (!same) parent.replaceChildren(...nodes);
}

// Range les choix dans les fiches : `ctx.refSlots` (table de l'export -> emplacement dans sa fiche) reçoit les colonnes Référence de la
// table ; sous le choix « Garder le lien » d'une colonne vient le panneau de la table qu'elle ajoute, avec à son tour les colonnes
// Référence de cette table (cascade). Une table ajoutée n'a qu'un panneau : les autres colonnes qui la visent le disent.
function place(ctx, offers, rows, blocks) {
  const taken = new Map(); // table ajoutée -> colonne sous laquelle son panneau est posé
  const fill = (table, slot) => {
    const mine = offers.rows.filter(r => r.table === table);
    for (const r of mine) {
      const block = r.link && !r.inside ? blocks.get(r.target) : null;
      const first = block && !taken.has(r.target);
      if (first) taken.set(r.target, `${r.table}.${r.label}`);
      rows.get(r.key).update(r, block && !first ? taken.get(r.target) : '');
      setChildren(rows.get(r.key).panel, first ? [block.node] : []);
      if (first) fill(r.target, block.slot);
    }
    setChildren(slot, mine.map(r => rows.get(r.key).node));
  };
  for (const table of ctx.chosen) if (ctx.refSlots.has(table)) fill(table, ctx.refSlots.get(table));
}

// Colonnes Référence et Liste de références de l'export, dans les fiches de leurs tables (`ctx.refSlots`, posés par l'écran avant cet
// appel). `onTables` reçoit les tables de l'export à chaque changement. Rend faux hors Échange (rien à régler).
export function linkSection(ctx, schema, onTables) {
  if (ctx.exp?.echange) return false;
  const rows = new Map(); // refKey -> ligne (gardée d'un dessin à l'autre : le focus reste)
  const blocks = new Map(); // table ajoutée -> { sig, node, slot }
  function refresh() {
    const offers = offersOf(ctx, schema);
    for (const map of [ctx.extras, ctx.pulls]) for (const table of [...map.keys()]) if (!offers.pulled.has(table)) map.delete(table);
    for (const r of offers.rows) if (!rows.has(r.key)) rows.set(r.key, refRow(ctx, r, refresh));
    for (const table of [...blocks.keys()]) if (!offers.pulled.has(table)) blocks.delete(table);
    for (const [table, required] of offers.pulled) {
      const sig = JSON.stringify(required);
      if (blocks.get(table)?.sig !== sig) blocks.set(table, { sig, ...pulledBlock(ctx, schema, { table, required, onChange: refresh }) });
    }
    place(ctx, offers, rows, blocks);
    onTables([...ctx.chosen, ...offers.pulled.keys()]);
  }
  ctx.refresh = refresh;
  refresh();
  return true;
}
