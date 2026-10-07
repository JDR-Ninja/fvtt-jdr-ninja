import { actorBase, makeIds } from './schema.mjs';
import { buildItems } from './items.mjs';

export function buildActor(source) {
  if (!source || source.schema !== '1' || !['monster', 'npc'].includes(source.kind)) throw new Error('Unknown export schema');
  if (source.edition !== '2024') throw new Error('Invalid rules edition');
  if (typeof source.name !== 'string' || !source.name.trim() || typeof source.biography !== 'string' || !Array.isArray(source.records) || !source.entries || typeof source.entries !== 'object') throw new Error('Incomplete source result');
  const recordTypes = new Set(['actor', 'ability', 'skill', 'movement', 'sense', 'language', 'defense', 'condition-immunity', 'attack', 'feature', 'routine', 'routine-attack', 'spell', 'damage', 'resource']);
  for (const record of source.records) if (!record || !recordTypes.has(record.type) || typeof record.id !== 'string' || !record.id) throw new Error('Invalid source record');
  const actor = actorBase(source);
  buildItems(source, actor, makeIds());
  return actor;
}

export const serializeActor = (source) => JSON.stringify(buildActor(source), null, 2);

export function filename(name) {
  const slug = String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  return `${slug || 'creature'}-foundry-dnd5e.json`;
}
