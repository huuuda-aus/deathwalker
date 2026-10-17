import { BASE, CELL, STORY, T, type Bay, type BayKind, type Ledge } from './buildingSpec';

/** The generated shape of a building: which structural member sits in every cell of its column x row grid. */
export interface Layout {
  stories: number;
  cols: number;
  rows: number;
  /** cell kinds, indexed column * rows + row */
  type: Uint8Array;
  ledges: Ledge[];
  /** members already knocked out by the ruin pass */
  ruinCount: number;
}

function cellType(col: { pillar: boolean; bay: number; local: number }, bays: Bay[], r: number): number {
  if (r % STORY === 0) return T.Slab; // foundation, floors, roof
  if (col.pillar) return T.Pillar;
  const bay = bays[col.bay];
  const kind = bay.kind;
  const k = r % STORY; // 1 spandrel, 2-3 glazing, 4 header
  if (kind === 'open' && bay.open[Math.floor(r / STORY)]) return k === 4 ? T.Wall : T.Empty; // firing bay: ledge + lintel
  if (kind === 'blank') return T.Wall;
  if (kind === 'stair') return (col.local === 0) === (k % 2 === 1) ? T.Stair : T.Empty; // zig-zag flights
  return k === 1 || k === 4 ? T.Wall : T.Window;
}

/** Knock the building about so it reads as a ruin, not a clean block. Edits `type` in place. */
function ruin(type: Uint8Array, cols: number, rows: number, colInfo: { pillar: boolean }[], stories: number, rnd: () => number): number {
  let killed = 0;
  const kill = (c: number, r: number): void => {
    if (c < 0 || c >= cols || r < 1 || r >= rows) return; // the foundation row stays
    const i = c * rows + r;
    if (type[i] !== T.Empty) { type[i] = T.Empty; killed++; }
  };
  const level = 0.4 + rnd() * 0.6; // how wrecked this one is

  // broken glazing and missing wall panels
  for (let c = 0; c < cols; c++) {
    for (let r = 1; r < rows; r++) {
      const t = type[c * rows + r];
      if (t === T.Window && rnd() < 0.1 + 0.35 * level) kill(c, r);
      else if (t === T.Wall && r >= STORY && rnd() < 0.15 * level) kill(c, r);
    }
  }
  // roof: gone, or partly gone
  const roofGone = rnd() < 0.55;
  for (let c = 0; c < cols; c++) if (roofGone ? rnd() < 0.85 : rnd() < 0.3 * level) kill(c, rows - 1);
  // ragged top storey
  const top0 = (stories - 1) * STORY + 1;
  for (let c = 0; c < cols; c++) {
    if (rnd() >= 0.7 * level) continue;
    const cut = top0 + Math.floor(rnd() * STORY);
    for (let r = cut + 1; r < rows; r++) kill(c, r);
  }
  // upper-level pillars that have fallen
  for (let c = 0; c < cols; c++) {
    if (!colInfo[c].pillar) continue;
    for (let st = 1; st < stories; st++) {
      if (rnd() < 0.2 * level) for (let k = 1; k < STORY; k++) kill(c, st * STORY + k);
    }
  }
  // holes in the floors above ground level
  for (let st = 1; st <= stories; st++) {
    if (rnd() >= 0.45 * level) continue;
    const start = Math.floor(rnd() * cols), len = 2 + Math.floor(rnd() * 4);
    for (let c = start; c < start + len; c++) kill(c, st * STORY);
  }
  // shell damage: bites out of the facade above the ground floor
  const bites = Math.floor(rnd() * (1 + 3 * level));
  for (let b = 0; b < bites; b++) {
    const cx = Math.floor(rnd() * cols), cy = STORY + Math.floor(rnd() * Math.max(1, rows - STORY)), rad = 1 + Math.floor(rnd() * 2);
    for (let c = cx - rad; c <= cx + rad; c++) for (let r = cy - rad; r <= cy + rad; r++) if ((c - cx) ** 2 + (r - cy) ** 2 <= rad * rad + 1) kill(c, r);
  }
  return killed;
}

/**
 * Random layout: pillars between bays at a variable height, then a ruin pass (missing roof, fallen upper
 * pillars, holes in floors, shell damage, broken glazing). Consumes `rnd` in a fixed order.
 */
export function generateLayout(x0: number, rnd: () => number): Layout {
  // ---- layout: pillars between bays; variable height
  const stories = [1, 2, 2, 3, 3, 4, 5][Math.floor(rnd() * 7)];
  const nBays = 3 + Math.floor(rnd() * 3);
  const stairBay = Math.floor(nBays / 2);                   // the staircase sits in the middle of the building
  const bays: Bay[] = [];
  const ledges: Ledge[] = [];
  for (let i = 0; i < nBays; i++) {
    const kind: BayKind = i === stairBay ? 'stair' : rnd() < 0.5 ? 'open' : rnd() < 0.3 ? 'blank' : 'window';
    const open = Array.from({ length: stories }, (_, st) => st === 0 || rnd() < 0.7);
    bays.push({ kind, width: kind === 'stair' ? 2 : 3, start: 0, open });
  }
  // the stairs stand against empty space, not a wall: the bay beside them is open on every floor
  const beside = bays[stairBay + (rnd() < 0.5 ? -1 : 1)] ?? bays[stairBay - 1];
  beside.kind = 'open';
  beside.open.fill(true);
  // every building offers at least one firing bay
  if (!bays.some((b) => b.kind === 'open')) bays[0].kind = 'open';
  // per column: pillar, or (bay index, local column)
  const colInfo: { pillar: boolean; bay: number; local: number }[] = [{ pillar: true, bay: -1, local: 0 }];
  bays.forEach((b, i) => {
    b.start = colInfo.length;
    for (let l = 0; l < b.width; l++) colInfo.push({ pillar: false, bay: i, local: l });
    colInfo.push({ pillar: true, bay: -1, local: 0 });
  });
  const cols = colInfo.length;
  const rows = stories * STORY + 1;
  for (const b of bays) {
    if (b.kind !== 'open') continue;
    for (let st = 0; st < stories; st++) {
      if (b.open[st]) ledges.push({ c0: b.start, c1: b.start + b.width - 1, r: st * STORY, x: x0 + (b.start + b.width / 2) * CELL, taken: 0 });
    }
  }

  const type = new Uint8Array(cols * rows);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      type[c * rows + r] = cellType(colInfo[c], bays, r);
    }
  }

  // ---- ruin: missing roof, fallen upper pillars, holes in floors, shell damage, broken glazing
  const ruinCount = ruin(type, cols, rows, colInfo, stories, rnd);

  // ---- the whole building stands on a big solid base block
  const total = rows + BASE;
  const full = new Uint8Array(cols * total);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < BASE; r++) full[c * total + r] = T.Slab;
    for (let r = 0; r < rows; r++) full[c * total + BASE + r] = type[c * rows + r];
  }
  for (const l of ledges) l.r += BASE;
  return { stories, cols, rows: total, type: full, ledges, ruinCount };
}
