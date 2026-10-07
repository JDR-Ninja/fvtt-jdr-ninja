const DAMAGE_TYPES = new Set(['bludgeoning', 'piercing', 'slashing', 'acid', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'poison', 'psychic', 'radiant', 'thunder']);
const PHYSICAL_TYPES = new Set(['bludgeoning', 'piercing', 'slashing']);
const KINDS = Object.freeze({ Resistance: 'dr', Immunity: 'di', Vulnerability: 'dv' });
const QUALIFIERS = new Set(['Unconditional', 'NonmagicalAttacks', 'NonmagicalAttacksNotSilvered', 'NonmagicalAttacksNotAdamantine']);
const CONDITIONS = new Set(['Blinded', 'Charmed', 'Deafened', 'Exhaustion', 'Frightened', 'Grappled', 'Incapacitated', 'Invisible', 'Paralyzed', 'Petrified', 'Poisoned', 'Prone', 'Restrained', 'Stunned', 'Unconscious']);

export function defenseTraits(source) {
  const traits = Object.fromEntries(Object.values(KINDS).map(key => [key, { value: [], custom: '', bypasses: [] }]));
  traits.ci = { value: [], custom: '' };
  const clauses = { dr: [], di: [], dv: [] };
  const seen = new Map();
  for (const row of source.records) {
    if (row.type === 'defense') {
      const key = Object.prototype.hasOwnProperty.call(KINDS, row['defense-kind']) ? KINDS[row['defense-kind']] : undefined;
      const damage = String(row['damage-type'] ?? '').toLowerCase();
      const qualifier = row.qualifier;
      if (!key || !DAMAGE_TYPES.has(damage) || !QUALIFIERS.has(qualifier)) throw new Error('Unknown damage defense');
      if (qualifier !== 'Unconditional' && (!PHYSICAL_TYPES.has(damage) || key === 'dv')) throw new Error('Invalid qualified damage defense');
      const previous = seen.get(damage) ?? [];
      if (previous.some(entry => entry.qualifier === qualifier || entry.qualifier === 'Unconditional' || qualifier === 'Unconditional')) throw new Error('Duplicate or contradictory damage defense');
      previous.push({ key, qualifier });
      seen.set(damage, previous);
      if (qualifier === 'Unconditional') traits[key].value.push(damage);
      else {
        if (typeof row.label !== 'string' || !row.label.trim() || /[<>;\r\n]/.test(row.label)) throw new Error('Missing or invalid selected defense label');
        // 5.3.3 bypasses are global per trait and apply to physical damage sources,
        // not attacks alone. Preserve attack-qualified clauses for manual handling.
        clauses[key].push(row.label);
      }
    } else if (row.type === 'condition-immunity') {
      if (!CONDITIONS.has(row.id)) throw new Error('Unknown condition immunity');
      const condition = row.id.toLowerCase();
      if (traits.ci.value.includes(condition)) throw new Error('Duplicate condition immunity');
      traits.ci.value.push(condition);
    }
  }
  for (const key of Object.values(KINDS)) {
    traits[key].value = [...new Set(traits[key].value)];
    traits[key].custom = clauses[key].join('; ');
  }
  return traits;
}
