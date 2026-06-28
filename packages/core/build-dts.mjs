// Generates TypeScript declarations for @guard-sdk/core with tsgo.
//
// The default `vp pack` dts pipeline (rolldown-plugin-dts) drops several of
// this package's exported types when bundling its large, self-contained type
// graph (it fails to follow some intra-file type references and tree-shakes the
// targets away, producing `Export 'X' is not defined`). tsgo emits correct
// per-file declarations, so the JS bundle is built with `--dts=false` and the
// declarations are generated here instead.
//
// tsgo emits `.d.ts` files for `.ts` sources; we rename them to `.d.mts` (and
// rewrite relative specifiers to `.mjs`) so they sit beside the emitted
// `index.mjs` and resolve under the package's `nodenext`/ESM exports.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const pkgJsonPath = require.resolve("@typescript/native-preview/package.json");
const tsgoLauncher = join(dirname(pkgJsonPath), "bin", "tsgo.js");

try {
  execFileSync(
    process.execPath,
    [
      tsgoLauncher,
      "--ignoreConfig",
      "--declaration",
      "--emitDeclarationOnly",
      "--outDir",
      "dist",
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      "--rootDir",
      "src",
      "--types",
      "node",
      "--skipLibCheck",
      "src/index.ts",
    ],
    { stdio: "inherit" },
  );
} catch (error) {
  // tsgo exits non-zero when it reports diagnostics, but still emits
  // declarations. Only fail the build if the entry declaration is missing.
  if (!existsSync(join("dist", "index.d.ts"))) {
    throw error;
  }
}

// Rename every emitted `.d.ts` to `.d.mts` and rewrite relative `./x.js`
// specifiers to `./x.mjs` so the declarations match the `.mjs` runtime files.
for (const file of readdirSync("dist")) {
  if (!file.endsWith(".d.ts")) {
    continue;
  }

  const source = join("dist", file);
  const target = join("dist", file.replace(/\.d\.ts$/, ".d.mts"));
  const rewritten = readFileSync(source, "utf8").replace(
    /(from\s+|import\s*\(\s*)(["'])(\.[^"']+)\.js(["'])/g,
    (_match, head, openQuote, path, closeQuote) => `${head}${openQuote}${path}.mjs${closeQuote}`,
  );

  writeFileSync(target, rewritten);
  rmSync(source);
}

if (!existsSync(join("dist", "index.d.mts"))) {
  throw new Error("tsgo did not emit dist/index.d.mts");
}
