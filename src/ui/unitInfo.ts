// Unit stat lines shared by the army setup screen and the battle HUD.

import { h } from './dom';
import { UNIT_TYPES, type ArmorClass, type UnitKind } from '../sim/unitTypes';

export function bonusText(kind: UnitKind): string {
  const a = UNIT_TYPES[kind].attack;
  const parts: string[] = [];
  const names: Partial<Record<ArmorClass, string>> = {
    cavalry: 'cavalry',
    spearman: 'pikemen',
    archer: 'archers',
    infantry: 'infantry',
    siege: 'siege',
  };
  for (const [cls, v] of Object.entries(a.damage) as [ArmorClass, number][]) {
    if (cls === 'melee' || cls === 'pierce') continue;
    parts.push(`+${v} vs ${names[cls] ?? cls}`);
  }
  return parts.join(', ');
}

/** Compact stat line; `withHp` false leaves out hit points (shown elsewhere). */
export function statsLine(kind: UnitKind, withHp = true): HTMLElement {
  const t = UNIT_TYPES[kind];
  const a = t.attack;
  const base = a.damage.melee ?? a.damage.pierce ?? 0;
  const type = a.damage.melee !== undefined ? 'melee' : 'pierce';
  const bonus = bonusText(kind);
  return h(
    'div',
    { class: 'stats' },
    withHp ? h('span', null, h('b', null, 'HP '), t.hp) : null,
    h('span', null, h('b', null, 'Attack '), `${base} ${type}`, bonus ? ` (${bonus})` : ''),
    h('span', null, h('b', null, 'Armour '), `${t.armor.melee ?? 0}/${t.armor.pierce ?? 0}`),
    a.kind === 'ranged' ? h('span', null, h('b', null, 'Range '), a.range) : null,
    a.splash ? h('span', null, h('b', null, 'Splash')) : null,
    h('span', null, h('b', null, 'Speed '), t.speed),
  );
}
