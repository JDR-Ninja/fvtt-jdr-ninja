import { ability, activation, addActivity, baseActivity, baseItem, damagePart, flag, modifier, number } from './schema.mjs';

function simple(record) {
  return !flag(record, 'utility-only') && !flag(record, 'damage-repeats') && !flag(record, 'repeat-save') && !flag(record, 'preparation-required') && !record.condition && (number(record, 'attack-count', { optional: true, min: 1 }) ?? 1) === 1;
}

// The SRD's eight schools of magic, as the metadata names them, in the D&D5e codes (CONFIG.DND5E.spellSchools).
const SCHOOLS = Object.freeze({ Abjuration: 'abj', Conjuration: 'con', Divination: 'div', Enchantment: 'enc', Evocation: 'evo', Illusion: 'ill', Necromancy: 'nec', Transmutation: 'trs' });

function spellSchool(record) {
  if (!Object.prototype.hasOwnProperty.call(SCHOOLS, record.school)) throw new Error('Unknown spell school');
  return SCHOOLS[record.school];
}

// A touch spell is Touch, which the metadata says and its 5 ft reach does not (a Self spell can strike in reach too);
// a distance of 0 is Self. Touch has no distance: D&D5e reads no value for a unit that is not a length.
function spellRange(record) {
  const feet = number(record, 'range', { min: 0 });
  if (flag(record, 'touch')) return { value: '', units: 'touch', special: '' };
  return { value: String(feet), units: feet === 0 ? 'self' : 'ft', special: '' };
}

function spellActivation(record) {
  // Reviewed source-ID exceptions from DndNpcSpellCatalog 2024.1, never prose parsing.
  if (record.id === 'flammes') return { type: 'bonus', value: 1, condition: '', override: true };
  if (['augure', 'communion-avec-la-nature'].includes(record.id) || flag(record, 'preparation-required')) return { type: 'special', value: null, condition: '', override: true };
  return activation(record);
}

export function spellItem(source, record, actor, ids, parts) {
  const item = baseItem(source, record, ids, 'spell');
  const level = number(record, 'level', { min: 0, max: 9 });
  number(record, 'cast-level', { min: level, max: 9 });
  const spellAbility = record.ability ? ability(record.ability) : actor.system.attributes.spellcasting;
  item.system = { ...item.system, level, ability: spellAbility, school: spellSchool(record), method: item.system.uses.max ? 'innate' : 'atwill', prepared: 1, properties: ['verbal', 'somatic', 'material', 'concentration'].filter((key) => flag(record, key)).map((key) => key === 'verbal' ? 'vocal' : key), materials: { value: '', consumed: flag(record, 'consumed'), cost: number(record, 'material-cost', { optional: true, min: 0 }) ?? 0, supply: 0 }, activation: activation(record), range: spellRange(record), duration: { units: 'spec', concentration: flag(record, 'concentration') } };
  // Allocation level remains in the selected description. No slots or automatic scaling.
  item.system.activation = spellActivation(record);
  let type = 'utility';
  if (simple(record) && record.effect === 'Attack' && flag(record, 'requires-attack') && parts.length) type = 'attack';
  else if (simple(record) && record.effect === 'DamageSave' && record['save-ability'] && parts.length) type = 'save';
  else if (simple(record) && record.effect === 'Healing' && record['healing-count'] !== undefined) type = 'heal';
  const activity = baseActivity(record, ids, type);
  activity.activation = spellActivation(record);
  activity.range = { ...item.system.range, override: true };
  if (type === 'attack') {
    const facts = source.records.find((row) => row.type === 'actor');
    activity.attack = { ability: 'none', bonus: String(number({ bonus: record['attack-bonus'] ?? facts['spell-attack'] }, 'bonus')), flat: true, critical: { threshold: 20 }, type: { value: number(record, 'range', { min: 0 }) > 5 ? 'ranged' : 'melee', classification: 'spell' } };
    activity.damage = { includeBase: false, critical: { bonus: '' }, parts };
  } else if (type === 'save') {
    const facts = source.records.find((row) => row.type === 'actor');
    activity.save = { ability: [ability(record['save-ability'])], dc: { calculation: '', formula: String(number({ dc: record.dc ?? facts['spell-dc'] }, 'dc', { min: 1 })) } };
    activity.damage = { onSave: flag(record, 'half-damage-on-save') ? 'half' : 'none', parts };
  } else if (type === 'heal') {
    const extra = flag(record, 'adds-healing-modifier') ? modifier(actor.system.abilities[spellAbility].value) : 0;
    activity.healing = damagePart({ count: record['healing-count'], sides: record['healing-sides'], bonus: record['healing-bonus'] }, extra, 'healing');
  }
  addActivity(item, activity);
  return item;
}
