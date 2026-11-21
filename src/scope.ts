// File-scope matching. Deterministic code decides scope, never the model.

export function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else { re += '.*'; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

export function inScope(path: string, scope: string[]): boolean {
  const p = path.replace(/\\/g, '/');
  return scope.some((g) => globToRegex(g).test(p));
}

/** Literal prefix before the first wildcard. */
function staticPrefix(glob: string): string {
  const i = glob.search(/[*?]/);
  return i === -1 ? glob : glob.slice(0, i);
}

/**
 * Conservative overlap test: two scopes overlap if any pair of patterns has static
 * prefixes where one is a prefix of the other. May report false overlaps; never misses one.
 */
export function scopesOverlap(a: string[], b: string[]): boolean {
  for (const x of a) for (const y of b) {
    const px = staticPrefix(x), py = staticPrefix(y);
    if (px.startsWith(py) || py.startsWith(px)) return true;
  }
  return false;
}
