/** Preserve data created by the contributor's Campaigns build without changing IDs or run evidence. */
export function topicNames(value: unknown, project = false): any {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const row = { ...value } as Record<string, unknown>;
  const oldKey = project ? 'campaigns' : 'campaignId';
  const newKey = project ? 'topics' : 'topicId';
  if (Object.hasOwn(row, oldKey)) {
    if (Object.hasOwn(row, newKey) && JSON.stringify(row[newKey]) !== JSON.stringify(row[oldKey]))
      throw new Error('Conflicting Topic and Campaign data. Keep the original backup and resolve the conflict before importing.');
    row[newKey] = row[oldKey];
    delete row[oldKey];
  }
  return row;
}
