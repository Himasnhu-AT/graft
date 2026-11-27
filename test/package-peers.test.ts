/**
 * Installing the package runs nothing and warns about nothing.
 *
 * An install script in the dependency tree is what made `npm install -g` compile
 * C: the depth tier's grammars were native addons, and `tree-sitter-kotlin` has no
 * prebuilt binary, so node-gyp ran (slowly, and not at all without a compiler).
 * They are WASM now (src/graph/depth-parser.ts) and the addons are dev
 * dependencies. An unmet peer is what printed a wall of "ERESOLVE overriding peer
 * dependency" warnings: tree-sitter-swift asked for a tree-sitter the package
 * didn't ship. The repo's own `overrides` hide that here, because npm applies
 * overrides only to the project it is run in, never to the people installing the
 * package, so both are read off the installed production tree instead
 * (`pnpm ls --prod`), with each package's own package.json on disk.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
type LsNode = { version: string; path: string; dependencies?: Record<string, LsNode> };
type Shipped = {
  name: string;
  version: string;
  hasInstallScript: boolean;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
};

/** What installing the published package puts on disk: the production dependency tree. */
function shippedPackages(): Shipped[] {
  const out = execFileSync("pnpm", ["ls", "--prod", "--depth", "Infinity", "--json"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
  });
  const top = (JSON.parse(out) as Array<{ dependencies?: Record<string, LsNode> }>)[0];
  const seen = new Map<string, Shipped>();
  const walk = (deps: Record<string, LsNode> | undefined): void => {
    for (const [name, node] of Object.entries(deps ?? {})) {
      const key = `${name}@${node.version}`;
      if (seen.has(key)) continue;
      const pkg = JSON.parse(readFileSync(join(node.path, "package.json"), "utf8"));
      const scripts = pkg.scripts ?? {};
      seen.set(key, {
        name,
        version: node.version,
        // npm runs `node-gyp rebuild` for a binding.gyp with no install script of its own.
        hasInstallScript: Boolean(scripts.preinstall || scripts.install || scripts.postinstall) ||
          existsSync(join(node.path, "binding.gyp")),
        peerDependencies: pkg.peerDependencies ?? {},
        peerDependenciesMeta: pkg.peerDependenciesMeta ?? {},
      });
      walk(node.dependencies);
    }
  };
  walk(top?.dependencies);
  return [...seen.values()];
}
const shipped = shippedPackages();

/** `version` satisfies `range`, for the plain `^x.y.z` ranges grammars use, joined by `||`. */
function satisfies(version: string, range: string): boolean {
  const [maj, min, pat] = version.split(".").map(Number);
  return range.split("||").some((part) => {
    const m = /^\s*\^(\d+)\.(\d+)\.(\d+)\s*$/.exec(part);
    assert.ok(m, `peer range "${part.trim()}" is not a ^x.y.z range; teach this test to read it`);
    const [a, b, c] = m.slice(1).map(Number);
    if (a !== maj) return false;
    if (a > 0) return min! > b! || (min === b && pat! >= c!);
    return min === b && pat! >= c!;
  });
}

test("the production tree is read at all", () => {
  assert.ok(shipped.some((p) => p.name === "tree-sitter-wasm"), "tree-sitter-wasm ships with the package");
});

test("no dependency of the package runs an install script, so installing it compiles nothing", () => {
  const scripted = shipped.filter((p) => p.hasInstallScript).map((p) => `${p.name}@${p.version}`);
  assert.deepEqual(scripted, []);
});

test("every required peer of a dependency ships with the package, in a version it accepts", () => {
  const versions = new Map<string, string[]>();
  for (const p of shipped) versions.set(p.name, [...(versions.get(p.name) ?? []), p.version]);
  const clashes: string[] = [];
  for (const p of shipped) {
    for (const [peer, range] of Object.entries(p.peerDependencies)) {
      if (p.peerDependenciesMeta[peer]?.optional) continue;
      const have = versions.get(peer) ?? [];
      if (!have.some((v) => satisfies(v, range))) clashes.push(`${p.name} wants ${peer} ${range}, ships ${have.join(", ") || "none"}`);
    }
  }
  assert.deepEqual(clashes, []);
});

test("the range check reads carets the way npm does", () => {
  assert.ok(satisfies("0.21.1", "^0.21.0"));
  assert.ok(!satisfies("0.21.1", "^0.22.1"));
  assert.ok(satisfies("0.21.1", "^0.22.1 || ^0.21.1"));
  assert.ok(satisfies("1.4.0", "^1.3.0"));
  assert.ok(!satisfies("2.0.0", "^1.3.0"));
});
