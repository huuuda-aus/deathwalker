export const CELL = 0.4;
/** Depth (z) of floors and pillars: the building's structural body. */
export const DEPTH = 6 * CELL;
/** Most depth layers a deep member (slab, pillar, stair) is built from. */
export const MAXL = 4;

/** Structural cell kinds. */
export const T = { Empty: 0, Slab: 1, Pillar: 2, Wall: 3, Window: 4, Stair: 5 } as const;

export interface Spec {
  hp: number;
  /** front face offset from the building's front plane (z0); positive = sticks out */
  front: number;
  thick: number;
  /** horizontal member: has limited span between supports */
  span: boolean;
  /** takes part in load paths (windows don't) */
  structural: boolean;
}

export const SPEC: Record<number, Spec> = {
  [T.Slab]:   { hp: 4, front: 0,             thick: DEPTH,       span: true,  structural: true },
  [T.Pillar]: { hp: 6, front: 0.25 * CELL,   thick: DEPTH,       span: false, structural: true },
  [T.Wall]:   { hp: 3, front: -0.125 * CELL, thick: 0.75 * CELL, span: true,  structural: true },
  [T.Window]: { hp: 1, front: -0.5 * CELL,   thick: 0.25 * CELL, span: false, structural: false },
  [T.Stair]:  { hp: 3, front: -1.25 * CELL,  thick: 2.5 * CELL,  span: false, structural: true },
};

/** Deep members are built from layers through their depth, so a bullet chews in layer by layer. */
export const DEEP: Record<number, number> = { [T.Slab]: MAXL, [T.Pillar]: MAXL, [T.Stair]: 2 };

export type BayKind = 'window' | 'open' | 'blank' | 'stair';
export interface Bay { kind: BayKind; width: number; start: number; /** per storey: open firing bay (no glazing/sill) */ open: boolean[] }

/** A floor opening enemies can stand in and shoot from. */
export interface Ledge {
  c0: number; c1: number; r: number; x: number;
  /** when it last hosted a spawn (a running count; 0 = never), so spawns rotate through the bays */
  taken: number;
}
export const STORY = 5; // rows per storey: slab, spandrel, window, window, header
