// Path helpers for resolving EPUB hrefs inside the zip.

export function unquote(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** Joins `rel` onto `base` and resolves `.` and `..` segments (zip paths always use `/`). */
export function joinPath(base: string, rel: string): string {
  const out: string[] = [];
  for (const part of [...base.split('/'), ...rel.split('/')]) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}
