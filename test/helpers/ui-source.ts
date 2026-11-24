import fs from "node:fs";
import path from "node:path";

/** Absolute paths of `<root>/public/js/*.js`, sorted by filename, non-recursive. */
export function uiModules(root: string = process.cwd()): string[] {
  const dir = path.join(root, "public", "js");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => entry.name)
    .sort()
    .map((name) => path.join(dir, name));
}

/** index.html followed by every public/js/*.js module, joined with newlines. */
export function uiSource(root: string = process.cwd()): string {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  return [html, ...uiModules(root).map((file) => fs.readFileSync(file, "utf8"))].join("\n");
}
