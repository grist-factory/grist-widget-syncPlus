// Logique pure : où poser la page du formulaire d'une réception dans la liste des pages de Grist (le
// menu de gauche) : juste sous la page de la table qui reçoit. (Ni DOM, ni `grist`, ni réseau.)
//
// Grist range les pages par `pagePos` (un nombre, une valeur intermédiaire suffit pour s'insérer) et
// montre une page comme la fille de la précédente quand son `indentation` est plus grande (vérifié :
// `UpdateRecord` sur `_grist_Pages` avec `pagePos` et `indentation`). Une page créée vient en fin de liste.

// Vues (pages de la liste) qui montrent les tables `dests` : la page propre de la table si elle existe,
// sinon la première page de la liste qui en montre une section. `tables`, `sections` et `pages` sont les
// lignes de `_grist_Tables`, `_grist_Views_section` et `_grist_Pages`.
export function destPageViews(dests, tables, sections, pages) {
  const listed = new Set(pages.map(p => p.viewRef));
  const views = [];
  for (const dest of dests) {
    const table = tables.find(tb => tb.tableId === dest);
    if (!table) continue;
    if (table.primaryViewId && listed.has(table.primaryViewId)) views.push(table.primaryViewId);
    else {
      const section = sections.find(s => s.tableRef === table.id && listed.has(s.parentId));
      if (section) views.push(section.parentId);
    }
  }
  return views;
}

// Place de la page `own` (sa vue) sous la plus basse des pages `anchors` (leurs vues), après ses
// éventuelles sous-pages, au même niveau : `{ pagePos, indentation }`. Rend null quand il n'y a rien à
// changer : aucune de ces pages n'est dans la liste, ou la page est déjà là.
export function placeBelow(pages, anchors, own) {
  const list = [...pages].sort((a, b) => a.pagePos - b.pagePos);
  const rest = list.filter(p => p.viewRef !== own);
  let at = -1;
  rest.forEach((p, i) => { if (anchors.includes(p.viewRef)) at = i; });
  if (at < 0) return null;
  const anchor = rest[at];
  let end = at;
  while (end + 1 < rest.length && rest[end + 1].indentation > anchor.indentation) end += 1;
  const before = rest[end];
  const after = rest[end + 1];
  const mine = list.find(p => p.viewRef === own);
  if (mine && mine.indentation === anchor.indentation && list[list.indexOf(mine) - 1] === before) return null;
  return { pagePos: after ? (before.pagePos + after.pagePos) / 2 : before.pagePos + 1, indentation: anchor.indentation };
}
