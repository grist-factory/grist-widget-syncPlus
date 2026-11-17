// SOURCE : l'avis des clés `id_sync` d'un export (lignes sans clé ou de même clé, colonnes du widget
// supprimées) et son bouton « Réparer les clés ». Le compte et la réparation sont dans le moteur
// (engine/source/keys.js).
import { repairKeys } from '../engine/source/keys.js';
import { confirmDialog, el, notice, run, smallButton } from '../ui.js';
import { t } from '../i18n.js';

// Avis d'un export : ce qui ne partira pas, pourquoi, et le bouton qui répare (`onDone` : redessin de l'onglet).
export function keysBlock(problems, onDone, { ownerOnly = false } = {}) {
  const out = el('div', { class: 'report' });
  const repair = smallButton(t('send.keys.repair'), 'edit', event => run(event.currentTarget, out, async () => {
    const lost = [...problems.values()].some(c => c.missing.length);
    const body = [lost ? t('send.keys.dialog.missing') : '', total(problems) ? t('send.keys.dialog.body', { n: total(problems) }) : ''].filter(Boolean).join(' ');
    if (!(await confirmDialog({ title: t('send.keys.dialog.title'), body, confirmLabel: t('send.keys.repair') }))) return;
    for (const table of problems.keys()) await repairKeys(table);
    await onDone();
  }), { kind: 'btn-primary', disabled: ownerOnly });
  const box = notice({
    tone: 'warn', title: t('send.keys.title'), lines: [t('send.keys.help')], 'data-keys': '',
    body: el('ul', { class: 'small' }, [...problems].flatMap(([table, c]) => [
      c.missing.length ? el('li', {}, t('send.keys.missing', { table, cols: c.missing.join(', '), n: c.missing.length })) : null,
      c.blank || c.dup ? el('li', {}, t('send.keys.line', { table, blank: c.blank, dup: c.dup })) : null,
    ].filter(Boolean))),
    actions: [repair],
  });
  box.append(out);
  return box;
}

const total = problems => [...problems.values()].reduce((n, c) => n + c.blank + c.dup, 0);

