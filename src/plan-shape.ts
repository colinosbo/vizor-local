export interface PlanShapeTask {
  key: string;
  deps: string[];
  writeScope: string[];
}

export interface PlanShape {
  waves: string[][];
  width: number;
  longestChain: number;
  chain: string[];
  hotFiles: { glob: string; tasks: string[] }[];
}

const HOT_FILE_THRESHOLD = 3;

/**
 * Pure description of a plan's parallelism: Kahn layering into waves, the
 * longest dependency chain, and write-scope globs many tasks fight over.
 * Tasks in or behind a cycle are left out of waves and chains. Deps on
 * unknown keys are ignored. If a key repeats, the first task wins.
 */
export function planShape(tasks: readonly PlanShapeTask[]): PlanShape {
  const unique: PlanShapeTask[] = [];
  const known = new Set<string>();
  for (const task of tasks) {
    if (known.has(task.key)) continue;
    known.add(task.key);
    unique.push(task);
  }

  const depsOf = new Map<string, string[]>();
  for (const task of unique) {
    depsOf.set(task.key, [...new Set(task.deps)].filter((d) => known.has(d)));
  }

  // Kahn layering: each pass takes every unplaced task whose deps are all placed.
  const placed = new Set<string>();
  const waves: string[][] = [];
  let remaining = unique.map((t) => t.key);
  while (remaining.length > 0) {
    const wave = remaining.filter((k) => (depsOf.get(k) ?? []).every((d) => placed.has(d)));
    if (wave.length === 0) break; // everything left is in or behind a cycle
    for (const k of wave) placed.add(k);
    waves.push(wave);
    remaining = remaining.filter((k) => !placed.has(k));
  }

  // Longest path: depth is 1 + best dep depth, ties resolved by input order.
  const order = new Map(unique.map((t, i) => [t.key, i]));
  const depth = new Map<string, number>();
  const prev = new Map<string, string | undefined>();
  for (const wave of waves) {
    for (const k of wave) {
      let best: string | undefined;
      for (const d of depsOf.get(k) ?? []) {
        const bd = best === undefined ? 0 : (depth.get(best) ?? 0);
        const dd = depth.get(d) ?? 0;
        if (best === undefined || dd > bd || (dd === bd && (order.get(d) ?? 0) < (order.get(best) ?? 0))) {
          best = d;
        }
      }
      depth.set(k, best === undefined ? 1 : (depth.get(best) ?? 0) + 1);
      prev.set(k, best);
    }
  }

  let leaf: string | undefined;
  for (const task of unique) {
    const d = depth.get(task.key);
    if (d !== undefined && (leaf === undefined || d > (depth.get(leaf) ?? 0))) leaf = task.key;
  }
  const chain: string[] = [];
  for (let k = leaf; k !== undefined; k = prev.get(k)) chain.unshift(k);

  const byGlob = new Map<string, string[]>();
  for (const task of unique) {
    for (const glob of new Set(task.writeScope)) {
      const list = byGlob.get(glob);
      if (list) list.push(task.key);
      else byGlob.set(glob, [task.key]);
    }
  }
  const hotFiles = [...byGlob.entries()]
    .filter(([, keys]) => keys.length >= HOT_FILE_THRESHOLD)
    .map(([glob, keys]) => ({ glob, tasks: keys }))
    .sort((a, b) => (a.glob < b.glob ? -1 : a.glob > b.glob ? 1 : 0));

  return {
    waves,
    width: waves.reduce((m, w) => Math.max(m, w.length), 0),
    longestChain: chain.length,
    chain,
    hotFiles,
  };
}
