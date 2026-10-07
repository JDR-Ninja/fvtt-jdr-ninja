import { ability, addActivity, baseActivity, baseItem, damagePart, entryFor, flag, number, rows, usesFor } from './schema.mjs';
import { spellItem } from './spells.mjs';

// How a template rolls in Foundry, the same for both kinds, by its core ID: one attack roll in melee at its range or at
// range; a save with its damage halved on a success, or none; extra damage after a hit; an ally's temporary hit points.
// Any other template keeps a utility activity, whose description says what to do (a trait without a roll keeps none).
const TEMPLATE_ACTIVITIES = Object.freeze({
  'lunging-strike': 'melee', 'long-lash': 'melee', 'measured-strike': 'melee', riposte: 'melee', 'close-strike': 'melee',
  'spine-shot': 'ranged', 'needle-shot': 'ranged', 'aimed-shot': 'ranged', 'scatter-shot': 'ranged',
  'corrosive-spit': 'save-half', 'cone-discharge': 'save-half', 'line-discharge': 'save-half',
  'coated-blade': 'save', grapple: 'save', net: 'save', 'hampering-blow': 'save', 'distracting-call': 'save',
  'precise-strike': 'damage', 'opening-strike': 'damage', 'concealed-strike': 'damage',
  'rally-ally': 'temphp'
});

// The two uses of a weapon that strikes in melee or is thrown, of a spell burst cast in melee or at range, in the
// sheet's language as the SRD 5.2.1 names them (« Corps à corps ou à distance »).
const MODE_NAMES = Object.freeze({ fr: { melee: 'Corps à corps', ranged: 'À distance' }, en: { melee: 'Melee', ranged: 'Ranged' } });

// An attack with a long range is a weapon item, which is where D&D5e keeps one (system.range.long; an activity's own range
// has none, see baseActivity). Its SRD category and properties travel in the metadata and map to the weapon type and the
// property codes; a monster's natural attack is the Natural type. The weapon carries no damage of its own (the activities
// hold every part the sheet prints) and is equipped and proficient. D&D5e takes one from the quantity each time a thrown
// weapon's Thrown attack mode is rolled, so a thrown weapon comes as a stack of THROWN_QUANTITY; any other is one of a kind.
const THROWN_QUANTITY = 10;
const WEAPON_PROPERTIES = Object.freeze({ thrown: 'thr', ammunition: 'amm', loading: 'lod', finesse: 'fin', light: 'lgt', heavy: 'hvy', 'two-handed': 'two', versatile: 'ver', 'reach-weapon': 'rch' });

function weaponType(record) {
  const category = record['weapon-category'];
  if (category === undefined) return undefined;
  if (category === 'Natural') return 'natural';
  if (category !== 'Simple' && category !== 'Martial') throw new Error('Unknown weapon category');
  return `${category.toLowerCase()}${flag(record, 'ammunition') ? 'R' : 'M'}`;
}

// Normal and long range as the weapon's own fields (always in feet), and the reach of its melee use; a weapon that is only
// thrown or shot has no reach (0), which D&D5e leaves out of its range label.
function weaponItem(source, record, ids, type) {
  const item = baseItem(source, record, ids, 'weapon');
  const range = number(record, 'range', { min: 1 });
  const longRange = number(record, 'long-range', { min: range });
  const reach = number(record, 'reach', { optional: true, min: 0 }) ?? 0;
  const properties = Object.entries(WEAPON_PROPERTIES).filter(([key]) => flag(record, key)).map(([, code]) => code);
  item.system = { ...item.system, type: { value: type, baseItem: '' }, properties, range: { value: range, long: longRange, reach, units: 'ft' }, equipped: true, proficient: 1, quantity: flag(record, 'thrown') ? THROWN_QUANTITY : 1 };
  return item;
}

export function attackActivity(source, record, ids, parts, mode, name = '', weapon = false) {
  const activity = baseActivity(record, ids, 'attack', mode);
  // The ranged use of a weapon item reads the item's range and long range; its melee use keeps its reach.
  if (weapon && mode === 'ranged') activity.range = { value: '', units: 'self', special: '', override: false };
  if (name) activity.name = name;
  activity.attack = { ability: 'none', bonus: String(number(record, 'bonus')), flat: true, critical: { threshold: 20 }, type: { value: mode, classification: flag(record, 'spell') ? 'spell' : 'weapon' } };
  activity.damage = { includeBase: false, critical: { bonus: '' }, parts };
  // Every source damage modifier is already included. A feat has no weapon base damage.
  return activity;
}

// A save the target makes (with either ability when it has the choice), with the damage of a failure halved or not on a success.
export function saveActivity(record, ids, parts, half) {
  const activity = baseActivity(record, ids, 'save');
  const abilities = [record['save-ability'], record['alternate-save-ability']].filter(Boolean).map(ability);
  activity.save = { ability: [...new Set(abilities)], dc: { calculation: '', formula: String(number(record, 'dc', { min: 1 })) } };
  activity.damage = { onSave: half ? 'half' : 'none', parts };
  return activity;
}

function featureActivity(source, record, ids, parts) {
  const mapping = record['source-type'] === 'template' ? TEMPLATE_ACTIVITIES[record.template] : undefined;
  let activity;
  if (mapping === 'melee' || mapping === 'ranged') activity = attackActivity(source, { ...record, reach: record.range }, ids, parts, mapping);
  else if (mapping === 'save-half' && parts.length) {
    activity = saveActivity(record, ids, parts, true);
    // A cone or a line starts from the creature; the spit reaches its range.
    if (record.template !== 'corrosive-spit') activity.range = { value: '', units: 'self', special: '', override: true };
  } else if (mapping === 'save') activity = saveActivity(record, ids, parts, false);
  else if (mapping === 'damage' && parts.length) {
    activity = baseActivity(record, ids, 'damage');
    // Extra damage after a hit doubles its dice on a critical hit, like the hit's own.
    activity.damage = { critical: { allow: true, bonus: '' }, parts };
  } else if (mapping === 'temphp' && number(record, 'magnitude', { optional: true, min: 1 })) {
    activity = baseActivity(record, ids, 'heal');
    activity.healing = damagePart({ count: 0, sides: 0, bonus: record.magnitude }, 0, 'temphp');
  } else if (record.timing === 'Trait') return null;
  else activity = baseActivity(record, ids, 'utility');
  // A trait's roll belongs to no action of its own: the hit or the turn that triggers it.
  if (record.timing === 'Trait') activity.activation = { type: 'special', value: null, condition: '', override: true };
  return activity;
}

export function buildItems(source, actor, ids) {
  const partsByOwner = new Map();
  for (const damage of rows(source, 'damage')) {
    if (!damage['owner-id']) throw new Error('Missing damage owner');
    const parts = partsByOwner.get(damage['owner-id']) ?? [];
    parts.push(damagePart(damage));
    partsByOwner.set(damage['owner-id'], parts);
  }
  const itemRecords = source.records.filter((row) => ['attack', 'feature', 'routine', 'spell'].includes(row.type));
  const itemIds = new Map();
  const usedEntries = new Set();
  const resources = new Map();
  for (const record of itemRecords) {
    if (!record.id || itemIds.has(record.id)) throw new Error('Duplicate or missing item identifier');
    let item;
    const parts = partsByOwner.get(record.id) ?? [];
    if (record.type === 'spell') item = spellItem(source, record, actor, ids, parts);
    else {
      const kind = record.type === 'attack' ? weaponType(record) : undefined;
      item = kind ? weaponItem(source, record, ids, kind) : baseItem(source, record, ids);
      if (record.type === 'attack') {
        // A reach strikes in melee and a range shoots; an attack with both is one item used either way.
        const modes = [['melee', 'reach'], ['ranged', 'range']].filter(([, key]) => number(record, key, { optional: true, min: 0 })).map(([mode]) => mode);
        if (!modes.length) throw new Error('Attack without reach or range');
        for (const mode of modes) addActivity(item, attackActivity(source, record, ids, parts, mode, modes.length > 1 ? MODE_NAMES[source.language === 'en' ? 'en' : 'fr'][mode] : '', !!kind));
      } else if (record.type === 'routine') {
        const steps = rows(source, 'routine-attack').filter((row) => row['owner-id'] === record.id);
        for (const step of steps) {
          entryFor(source, step['attack-id']);
          number(step, 'count', { min: 1 });
          if (!itemRecords.some((row) => row.id === step['attack-id'] && row.type === 'attack')) throw new Error('Invalid routine attack reference');
        }
        addActivity(item, baseActivity({ ...record, timing: record.timing ?? 'Action' }, ids, 'utility'));
      } else {
        const activity = featureActivity(source, record, ids, parts);
        if (activity) addActivity(item, activity);
      }
    }
    if (record['resource-id'] && record.timing !== 'Legendary') {
      const id = record['resource-id'];
      const resource = rows(source, 'resource').find((row) => row.id === id);
      if (!resource) throw new Error('Missing shared resource');
      const owner = resources.get(id);
      if (owner) {
        item.system.uses = { max: '', spent: 0, recovery: [] };
        for (const activity of Object.values(item.system.activities)) activity.consumption.targets = [{ type: 'itemUses', target: owner._id, value: '1', scaling: { mode: '', formula: '' } }];
      } else {
        item.system.uses = usesFor(resource);
        for (const activity of Object.values(item.system.activities)) activity.consumption.targets = item.system.uses.max ? [{ type: 'itemUses', target: '', value: '1', scaling: { mode: '', formula: '' } }] : [];
        resources.set(id, item);
      }
    }
    // Legendary actions and resistances use the actor's trackers, not an item use pool.
    if (record.timing === 'Legendary' || record['source-type'] === 'legendary-resistance') {
      item.system.uses = { max: '', spent: 0, recovery: [] };
      for (const activity of Object.values(item.system.activities)) activity.consumption.targets = [];
    }
    itemIds.set(record.id, item._id);
    usedEntries.add(record.id);
    actor.items.push(item);
  }
  for (const id of partsByOwner.keys()) if (!usedEntries.has(id)) throw new Error('Unknown damage owner');
  for (const [id] of Object.entries(source.entries)) {
    if (usedEntries.has(id)) continue;
    // Known narrative-only blocks still survive even when a primitive is unsupported.
    actor.items.push(baseItem(source, { id, timing: 'Trait' }, ids));
  }
  return actor.items;
}
