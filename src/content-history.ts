type Version = { id: string; createdAt: string; derivedFrom?: string };

/** Explicit revision links preserve separate drafts even when their titles match. */
export function contentHistory<T extends Version>(drafts: T[]): T[][] {
  const byId = new Map(drafts.map(draft => [draft.id, draft]));
  const parents = new Map(drafts.map(draft => [draft.id, draft.id]));
  function root(id: string): string {
    let ancestor = id;
    while (parents.get(ancestor) !== ancestor) ancestor = parents.get(ancestor)!;
    while (id !== ancestor) {
      const parent = parents.get(id)!;
      parents.set(id, ancestor); id = parent;
    }
    return ancestor;
  }
  for (const draft of drafts) {
    if (!draft.derivedFrom || !byId.has(draft.derivedFrom)) continue;
    const own = root(draft.id), original = root(draft.derivedFrom);
    if (own !== original) parents.set(own, original);
  }
  const order = new Map(drafts.map((draft, index) => [draft.id, index]));
  const recentFirst = (a: T, b: T) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || order.get(a.id)! - order.get(b.id)!;
  const groups = new Map<string, T[]>();
  for (const draft of drafts) {
    const id = root(draft.id), versions = groups.get(id) ?? [];
    versions.push(draft); groups.set(id, versions);
  }
  return [...groups.values()].map(versions => versions.sort(recentFirst)).sort((a, b) => recentFirst(a[0], b[0]));
}
