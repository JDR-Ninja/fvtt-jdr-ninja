import { defenseTraits } from './defenses.mjs';

// Native source fields are pinned to foundryvtt/dnd5e release-5.3.3.
export const TARGET = Object.freeze({ foundry: 14, system: 'dnd5e', version: '5.3.3' });
export const ABILITIES = Object.freeze({ Strength: 'str', Dexterity: 'dex', Constitution: 'con', Intelligence: 'int', Wisdom: 'wis', Charisma: 'cha' });
const SKILLS = Object.freeze({ acrobatics: 'acr', animalHandling: 'ani', 'animal-handling': 'ani', arcana: 'arc', athletics: 'ath', deception: 'dec', history: 'his', insight: 'ins', intimidation: 'itm', investigation: 'inv', medicine: 'med', nature: 'nat', perception: 'prc', performance: 'prf', persuasion: 'per', religion: 'rel', sleightOfHand: 'slt', 'sleight-of-hand': 'slt', stealth: 'ste', survival: 'sur' });
const SIZES = Object.freeze({ Tiny: 'tiny', Small: 'sm', Medium: 'med', Large: 'lg', Huge: 'huge', Gargantuan: 'grg' });
const CREATURE_TYPES = Object.freeze({ Aberration: 'aberration', Beast: 'beast', Celestial: 'celestial', Construct: 'construct', Dragon: 'dragon', Elemental: 'elemental', Fey: 'fey', Fiend: 'fiend', Giant: 'giant', Humanoid: 'humanoid', Monstrosity: 'monstrosity', Ooze: 'ooze', Plant: 'plant', Undead: 'undead' });
const LANGUAGES = Object.freeze({ Commun: 'common', 'Argot des voleurs': 'cant', Elfique: 'elvish', Nain: 'dwarvish', Halfelin: 'halfling', Gnome: 'gnomish', Draconique: 'draconic', 'Géant': 'giant', Orc: 'orc', Infernal: 'infernal' });
const DAMAGE_TYPES = new Set(['bludgeoning', 'piercing', 'slashing', 'acid', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'poison', 'psychic', 'radiant', 'thunder']);
const ECONOMY = Object.freeze({ Trait: '', Action: 'action', BonusAction: 'bonus', Reaction: 'reaction', Legendary: 'legendary', Lair: 'lair' });
const ALIGNMENTS = Object.freeze({ LawfulGood: 'lg', NeutralGood: 'ng', ChaoticGood: 'cg', LawfulNeutral: 'ln', Neutral: 'tn', ChaoticNeutral: 'cn', LawfulEvil: 'le', NeutralEvil: 'ne', ChaoticEvil: 'ce', Unaligned: 'Unaligned' });

export function number(record, key, { optional = false, min = -10000, max = 10000, integer = true } = {}) {
  const value = record[key];
  if (optional && (value === undefined || value === null || value === '')) return undefined;
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(value ?? ''))) throw new Error(`Invalid ${key}`);
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max || (integer && !Number.isInteger(result))) throw new Error(`Invalid ${key}`);
  return result;
}

export function flag(record, key) {
  const value = record[key];
  if (value === undefined || value === null || value === '') return false;
  if (value === true || value === '1' || String(value).toLowerCase() === 'true') return true;
  if (value === false || value === '0' || String(value).toLowerCase() === 'false') return false;
  throw new Error(`Invalid ${key}`);
}

export function ability(value) {
  const code = ABILITIES[value];
  if (!code) throw new Error('Unknown source ability');
  return code;
}
export const modifier = (score) => Math.floor((score - 10) / 2);
export const rows = (source, type) => source.records.filter((row) => row.type === type);
export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export const safeUrl = (value) => /^https?:\/\//i.test(value ?? '') ? value : '';

export function makeIds() {
  let next = 0;
  return () => `jn${String(++next).padStart(14, '0')}`;
}

export function sourceField(source, adaptedSpell = false) {
  return { custom: adaptedSpell ? 'JDR Ninja / SRD 5.2.1' : 'JDR Ninja', rules: source.edition, ...(adaptedSpell ? { license: 'CC-BY-4.0' } : {}) };
}

export function diceFormula(count, sides, bonus) {
  return `${count ? `${count}d${sides}` : '0'}${bonus > 0 ? ` + ${bonus}` : bonus < 0 ? ` - ${-bonus}` : ''}`;
}

// A damage, healing or temporary hit point part. No dice (0d0) is a flat amount: an opening's extra damage, a rally's
// temporary hit points.
export function damagePart(record, extraBonus = 0, healing = '') {
  const count = number(record, 'count', { min: 0 });
  const sides = number(record, 'sides', { min: 0 });
  if (count && ![1, 2, 3, 4, 6, 8, 10, 12, 20, 100].includes(sides)) throw new Error('Invalid dice denomination');
  if (healing && !['healing', 'temphp'].includes(healing)) throw new Error('Unknown healing type');
  const damageType = String(record['damage-type'] ?? '').toLowerCase();
  if (!healing && !DAMAGE_TYPES.has(damageType)) throw new Error('Unknown damage type');
  return { number: count, denomination: sides, bonus: String(number(record, 'bonus') + extraBonus), types: [healing || damageType], custom: { enabled: false, formula: '' }, scaling: { mode: '', number: 1, formula: '' } };
}

export function usesFor(record) {
  const max = number(record, 'uses', { optional: true, min: 0 }) ?? 0;
  const spent = number(record, 'spent', { optional: true, min: 0, max }) ?? 0;
  const recharge = number(record, 'recharge', { optional: true, min: 0, max: 6 }) ?? 0;
  if (recharge && recharge < 2) throw new Error('Invalid recharge');
  const dailyPeriod = record.template === 'shed-grip' ? 'lr' : 'day';
  return { max: max ? String(max) : recharge ? '1' : '', spent, recovery: recharge ? [{ period: 'recharge', type: 'recoverAll', formula: String(recharge) }] : max ? [{ period: dailyPeriod, type: 'recoverAll', formula: '' }] : [] };
}

export function activation(record) {
  const type = ECONOMY[record.timing ?? 'Trait'];
  if (type === undefined) throw new Error('Unknown timing');
  return { type, value: type ? number(record, 'cost', { optional: true, min: 1 }) ?? 1 : null, condition: '', override: true };
}

export function entryFor(source, id) {
  const entry = source.entries[id];
  if (!entry || typeof entry.name !== 'string' || !entry.name.trim() || typeof entry.description !== 'string') throw new Error(`Missing rule entry: ${id}`);
  return entry;
}

export function baseItem(source, record, ids, type = 'feat') {
  const entry = entryFor(source, record.id);
  const link = safeUrl(entry.sourceUrl);
  return { _id: ids(), name: entry.name, type, img: 'icons/svg/book.svg', effects: [], system: { description: { value: entry.description + (link ? `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>` : ''), chat: '' }, source: sourceField(source, type === 'spell'), uses: usesFor(record), activities: {} } };
}

// An attack activity strikes in melee at its reach or shoots at its range and long range; any other activity reaches its
// range, or its reach when it has no range. D&D5e 5.3.3 gives an activity's range a value, a unit and a note (RangeField),
// and a long range only to a weapon item's own system.range.long: a feat's activity has no long-range field (an
// undeclared key is dropped on import), so the long range of an attack that is not a weapon item (a role template such as
// Aimed Shot) travels as the range note, « 20/60 ft ». The ranged use of a weapon item takes the item's range instead
// (see attackActivity in items.mjs).
export function baseActivity(record, ids, type, mode = '') {
  const reach = number(record, 'reach', { optional: true, min: 0 });
  const normal = number(record, 'range', { optional: true, min: 0 });
  const range = mode === 'melee' ? reach : mode === 'ranged' ? normal : normal ?? reach;
  const longRange = mode === 'ranged' ? number(record, 'long-range', { optional: true, min: range ?? 0 }) : undefined;
  return { _id: ids(), type, activation: activation(record), consumption: { spellSlot: false, targets: [], scaling: { allowed: false, max: '' } }, duration: { units: record.type === 'spell' || type === 'utility' ? 'spec' : 'inst', concentration: flag(record, 'concentration'), override: true }, range: { value: range === undefined ? '' : String(range), units: range === undefined || range === 0 ? 'self' : 'ft', special: longRange ? `${range}/${longRange} ft` : '', override: true }, target: { override: true, prompt: true, affects: { type: '', count: '', choice: false, special: '' }, template: { type: '', size: '', units: 'ft', contiguous: false } }, uses: { max: '', spent: 0, recovery: [] }, effects: [] };
}

export function addActivity(item, activity) {
  item.system.activities[activity._id] = activity;
  if (item.system.uses.max) activity.consumption.targets = [{ type: 'itemUses', target: '', value: '1', scaling: { mode: '', formula: '' } }];
}

export function actorBase(source) {
  const actorRows = rows(source, 'actor');
  if (actorRows.length !== 1) throw new Error('Expected one actor record');
  const facts = actorRows[0];
  const cr = number(facts, 'cr', { min: 0, max: 30, integer: false });
  if (!Number.isInteger(cr) && ![0.125, 0.25, 0.5].includes(cr)) throw new Error('Unsupported CR');
  const pb = number(facts, 'pb', { min: 2, max: 9 });
  if (pb !== Math.max(2, Math.ceil(cr / 4) + 1)) throw new Error('Source proficiency does not match CR');
  const size = SIZES[facts.size];
  if (!size) throw new Error('Unknown creature size');
  const sourceAbilities = rows(source, 'ability');
  if (sourceAbilities.length !== 6) throw new Error('Expected six abilities');
  const abilities = {};
  for (const row of sourceAbilities) {
    const code = ability(row.id);
    if (abilities[code]) throw new Error('Duplicate ability');
    const score = number(row, 'score', { min: 0, max: 99 });
    const total = number(row, 'save', { optional: true });
    const prof = total !== undefined && total - modifier(score) >= pb ? 1 : 0;
    abilities[code] = { value: score, proficient: prof, bonuses: { check: '', save: total === undefined ? '' : String(total - modifier(score) - prof * pb) } };
  }
  const skills = {};
  for (const row of rows(source, 'skill')) {
    const code = SKILLS[row.id];
    if (!code || skills[code]) throw new Error('Unknown or duplicate skill');
    const abl = ability(row.ability);
    const prof = number(row, 'multiplier', { min: 0, max: 2, integer: false });
    if (![0, 0.5, 1, 2].includes(prof)) throw new Error('Invalid skill proficiency');
    const bonus = number(row, 'bonus');
    skills[code] = { value: prof, ability: abl, bonuses: { check: String(bonus - modifier(abilities[abl].value) - Math.floor(pb * prof)), passive: '' } };
  }
  const passive = number(facts, 'passive-perception', { optional: true });
  if (passive !== undefined) {
    const perception = skills.prc ??= { value: 0, ability: 'wis', bonuses: { check: '0', passive: '' } };
    const total = modifier(abilities[perception.ability].value) + Math.floor(pb * perception.value) + Number(perception.bonuses.check);
    perception.bonuses.passive = String(passive - 10 - total);
  }
  const movement = { units: 'ft' };
  for (const row of rows(source, 'movement')) {
    if (!['walk', 'climb', 'swim', 'fly', 'burrow'].includes(row.id) || row.id in movement) throw new Error('Unknown or duplicate movement');
    movement[row.id] = number(row, 'value', { min: 0 });
  }
  const senses = { units: 'ft', ranges: {} };
  for (const row of rows(source, 'sense')) {
    if (!['darkvision', 'blindsight', 'tremorsense', 'truesight'].includes(row.id) || row.id in senses.ranges) throw new Error('Unknown or duplicate sense');
    senses.ranges[row.id] = number(row, 'value', { min: 0 });
  }
  const languages = { value: [], custom: '' };
  const unknown = [];
  for (const row of rows(source, 'language')) {
    const language = LANGUAGES[row.id];
    if (language) languages.value.push(language); else unknown.push(row.id);
  }
  languages.value = [...new Set(languages.value)];
  languages.custom = unknown.join('; ');
  const defenses = defenseTraits(source);
  const hp = number(facts, 'hp', { min: 1 });
  const hpCount = number(facts, 'hp-count', { min: 0 });
  const hpSides = number(facts, 'hp-sides', { min: 1 });
  const hpBonus = number(facts, 'hp-modifier');
  if (![4, 6, 8, 10, 12, 20].includes(hpSides)) throw new Error('Invalid hit dice');
  const initiative = number(facts, 'initiative', { optional: true });
  const spellcasting = facts['spell-ability'] ? ability(facts['spell-ability']) : '';
  const lair = number(facts, 'lair-initiative', { optional: true, min: 0 });
  const creatureType = CREATURE_TYPES[facts['creature-type']];
  if (!creatureType) throw new Error('Unknown creature type');
  if (facts.alignment && !Object.prototype.hasOwnProperty.call(ALIGNMENTS, facts.alignment)) throw new Error('Unknown source alignment');
  return {
    name: source.name, type: 'npc', img: 'icons/svg/mystery-man.svg',
    system: {
      abilities, skills,
      attributes: {
        ac: { calc: 'flat', flat: number(facts, 'ac', { min: 0 }), formula: '' },
        hp: { value: hp, max: hp, temp: 0, tempmax: 0, formula: diceFormula(hpCount, hpSides, hpBonus) },
        movement, senses,
        init: { ability: 'dex', bonus: initiative === undefined ? '' : String(initiative - modifier(abilities.dex.value)) },
        spellcasting
      },
      details: {
        cr, alignment: facts.alignment ? ALIGNMENTS[facts.alignment] : '',
        type: { value: creatureType, subtype: facts['creature-subtype'] ?? '', custom: '' },
        biography: { value: source.biography, public: '' }
      },
      traits: { size, languages, ...defenses },
      resources: {
        legact: { max: number(facts, 'legendary-max', { optional: true, min: 0 }) ?? 0, spent: 0 },
        legres: { max: number(facts, 'legendary-resistance-max', { optional: true, min: 0 }) ?? 0, spent: 0 },
        lair: { value: lair !== undefined, initiative: lair ?? 20, inside: false }
      },
      source: sourceField(source)
    },
    items: [], effects: [], ownership: { default: 0 }
  };
}
