// CIBLE : la fenêtre « Reprendre depuis la SOURCE » : une case par élément que l'export envoie (mise en forme, descriptions),
// cochées d'emblée ; et, à part, les formules (Python, voir engine/logic/column-formulas.js) : décochées, réservées aux
// propriétaires, avec la liste de chaque formule lue (ce qu'elle remplace, ce qui s'oppose à la poser) et une case « J'ai lu »
// sans laquelle le bouton reste grisé. Rend les éléments choisis (un Set), ou null si la personne renonce.
import { el, message, openModal } from '../ui.js';
import { t } from '../i18n.js';

// Texte de l'état d'une formule : posée d'office, déjà là, ou refusée (avec ses raisons).
function itemView(item) {
  const state = item.kind === 'default' ? { data: 'defData', other: 'defOther', same: 'defSame' }[item.state] : item.state;
  const head = item.ok ? t(`recv.formulas.state.${state}`) : t('recv.formulas.refused');
  const kind = item.kind === 'default' ? ` · ${t('recv.formulas.kind.default')}` : '';
  return el('li', { class: 'formula-item' },
    el('div', {}, el('strong', {}, item.label === item.to ? item.to : `${item.label} (${item.to})`), el('span', { class: 'muted small' }, `${kind} · ${head}`)),
    el('pre', { class: 'code formula-code' }, item.formula),
    item.problems.length ? el('ul', { class: 'small' }, item.problems.map(p => el('li', {}, t(`recv.formulas.problem.${p.code}`, { name: p.name, to: p.to || '' })))) : null);
}

// `formulas` : par table reçue, `{ table, items }` (voir planFormulas). `kinds` : ce que l'export envoie ('style', 'notes', 'table',
// 'formulas'). Les formules ne s'offrent qu'à un propriétaire (`owner`) et quand une au moins est à poser.
export function restyleDialog({ name, kinds, owner, formulas }) {
  return new Promise((resolve) => {
    const plain = kinds.filter(kind => kind !== 'formulas');
    const chosen = new Set(plain);
    const items = formulas.flatMap(f => f.items);
    const todo = items.filter(i => i.ok && i.state !== 'same').length;
    let answered = false;
    let read = false;
    const refresh = () => modal.setButtons(buttons());
    const boxes = plain.map((kind) => {
      const box = el('input', { type: 'checkbox', checked: true, onchange: () => { if (box.checked) chosen.add(kind); else chosen.delete(kind); refresh(); } });
      return el('label', { class: 'check' }, box, t(`recv.restyle.${kind}`));
    });
    const sure = el('input', { type: 'checkbox', onchange: () => { read = sure.checked; refresh(); } });
    const panel = el('div', { class: 'form formulas-panel hidden' },
      message('warn', t('recv.formulas.intro')), el('p', { class: 'small' }, t('recv.formulas.replaces')),
      formulas.map(f => [el('h3', {}, t('recv.formulas.table', { table: f.table })), el('ul', { class: 'formula-list' }, f.items.map(itemView))]),
      el('label', { class: 'check' }, sure, t('recv.formulas.read')));
    const formulaBox = () => {
      if (!kinds.includes('formulas')) return null;
      if (!owner) return el('p', { class: 'muted small' }, t('recv.restyle.formulas.owner'));
      const box = el('input', {
        type: 'checkbox', checked: false, disabled: !todo,
        onchange: () => { if (box.checked) chosen.add('formulas'); else chosen.delete('formulas'); panel.classList.toggle('hidden', !box.checked); refresh(); },
      });
      return el('div', { class: 'form formulas-box' }, el('label', { class: 'check' }, box, t('recv.restyle.formulas'),
        el('span', { class: 'muted small' }, ` · ${todo ? t('recv.formulas.count', { n: todo }) : t('recv.formulas.none')}`)), panel);
    };
    const buttons = () => [
      { label: t('common.cancel'), onClick: (m) => { answered = true; resolve(null); m.close(); } },
      { label: t('recv.restyle.confirm'), kind: 'btn-primary', disabled: !chosen.size || (chosen.has('formulas') && !read), onClick: (m) => { answered = true; resolve(new Set(chosen)); m.close(); } },
    ];
    const modal = openModal({
      title: t('recv.restyle.title', { name }), width: 720, buttons: buttons(),
      body: el('div', {}, el('p', {}, t('recv.restyle.body')), el('div', { class: 'form' }, ...boxes), formulaBox()),
      onClose: () => { if (!answered) resolve(null); },
    });
    modal.footer.querySelector('button').focus();
  });
}
