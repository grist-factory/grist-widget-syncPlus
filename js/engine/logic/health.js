// SOURCE : ce qui se passe pour un export, en une phrase. La carte ne dit plus seulement « un envoi
// n'est pas terminé » : elle dit où il en est, ce qu'il attend, ou pourquoi il ne bouge pas.
import { LEASE_S, etaSeconds, percent } from './resend.js';

// `owed` : nombre de tables de l'export qui ont encore des lignes ou une liste des clés à envoyer.
// `recipients` : état de chaque destinataire (`hookStatus`) : 'active', 'paused' ou 'error'.
// `charge` : la ligne 'charge' lue (`parseCharge`). `page` : cette page. `lastPass` : dernier passage
// du rattrapage de cette page ({ at } en millisecondes, 0 s'il n'a pas eu lieu).
// Rend { key, vars } (clé `send.flow.<key>`), ou null quand tout est parti.
export function exportFlow({ exportId, owed, recipients, charge, page, now, lastPass = { at: 0 } }) {
  const running = Boolean(charge.par) && now - charge.le < LEASE_S;
  const prog = charge.prog && charge.prog.exp === exportId ? charge.prog : null;
  if (running && prog) {
    const left = etaSeconds(prog, charge, now);
    const vars = {
      done: prog.done, total: prog.total, pct: percent(prog), lot: prog.lots + 1, lots: Math.max(prog.lotsTotal, prog.lots + 1), table: prog.table, left, at: charge.reprise,
    };
    if (charge.reprise > now) return { key: 'budget', vars };
    return { key: charge.par === page ? 'running' : 'runningOther', vars };
  }
  if (!owed) return null;
  if (running) return charge.reprise > now ? { key: 'budgetWait', vars: { at: charge.reprise } } : { key: 'queued', vars: {} };
  const live = recipients.filter(s => s !== 'paused');
  if (!live.length) return { key: 'paused', vars: { n: owed } };
  const failing = live.filter(s => s === 'error').length;
  if (failing) return { key: 'blocked', vars: { n: failing } };
  if (prog) return { key: 'interrupted', vars: { done: prog.done, total: prog.total, pct: percent(prog) } };
  return { key: 'waiting', vars: { n: owed, at: lastPass.at } };
}

// Un état qui change tout seul : la carte se redessine pour le suivre.
export const flowMoves = flow => Boolean(flow) && ['running', 'runningOther', 'budget', 'budgetWait', 'queued', 'waiting'].includes(flow.key);
