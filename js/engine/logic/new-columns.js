// SOURCE : les colonnes qu'une personne ajoute après coup aux tables d'un export. Une colonne qui existait à l'enregistrement de l'export
// (ou au dernier choix) et que la personne n'a pas cochée est un choix : elle n'est jamais signalée. Une colonne arrivée depuis n'est pas
// envoyée : l'export le dit, avec un geste pour l'envoyer (« Envoyer ces colonnes »), ou l'ignorer. Un export peut aussi les envoyer seul
// (`autoCols`, décoché d'emblée, jamais en Échange) : le choix de la personne, pas un réglage par défaut.
// `known` (note SOURCE, entrée de l'export) : { <table>: [identifiants des colonnes envoyables à ce moment-là] }.
import { exportableColumns } from './exports.js';
import { noteSent } from './descriptions.js';
import { formulasOffered } from './column-formulas.js';
import { layoutSent } from './layout.js';

// Les colonnes envoyables de chacune des tables `tables` ([{ table, ... }]) qui existent.
export const knownColumns = (schema, tables) => Object.fromEntries(tables.filter(tb => schema.has(tb.table))
  .map(tb => [tb.table, exportableColumns(schema.columns(tb.table)).map(c => c.id)]));

// Colonnes envoyables d'une table de l'export, ni envoyées ni connues : [{ table, columns: [{ id, type }] }]. Sans `known` (export d'avant
// ce suivi) ou pour une table qu'il ne cite pas, rien n'est dit : la référence se pose d'abord (voir engine/source/new-columns.js).
export function newColumns(schema, tables, known) {
  if (!known) return [];
  return tables.filter(tb => schema.has(tb.table) && Array.isArray(known[tb.table])).flatMap(({ table, columns }) => {
    const sent = new Set(columns.map(c => c.id));
    const old = new Set(known[table]);
    const fresh = exportableColumns(schema.columns(table)).filter(c => !sent.has(c.id) && !old.has(c.id));
    return fresh.length ? [{ table, columns: fresh.map(c => ({ id: c.id, type: c.source || c.type })) }] : [];
  });
}

// Ce que l'export envoie en plus des données (les cases de l'étape Colonnes), lu dans ses colonnes : pour enregistrer l'export sans que la
// personne repasse par l'assistant.
export function exportFlags(tables) {
  const columns = tables.flatMap(tb => tb.columns);
  const sent = noteSent(columns);
  return { links: columns.some(c => c.link), style: columns.some(c => c.fmt), notes: sent.notes, tableNote: sent.table, layout: layoutSent(columns), formulas: formulasOffered(columns) };
}

// Le choix de colonnes qui enregistre l'export avec `additions` ([{ table, columns: [identifiants] }]) en plus : ses tables, ses colonnes,
// son filtre.
export const widenedSelection = (tables, additions) => tables.map(({ table, columns, filter }) => ({
  table, filter: filter || null,
  columns: [...columns.map(c => c.id), ...(additions.find(a => a.table === table)?.columns || [])],
}));
