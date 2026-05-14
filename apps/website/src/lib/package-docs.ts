import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type ApiSymbolKind =
  | "function"
  | "class"
  | "const"
  | "type"
  | "interface"
  | "reexport"
  | "default"
  | "unknown";

export type ApiSymbol = {
  kind: ApiSymbolKind;
  name: string;
  declaration: string;
  source?: string;
};

export type PackageDoc = {
  slug: string;
  name: string;
  version: string;
  description: string;
  readmeSummary: string;
  internalDependencies: string[];
  peerDependencies: string[];
  exportStatements: string[];
  exports: ApiSymbol[];
};

type PackageJson = {
  name: string;
  version?: string;
  description?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const repoRoot = resolve(process.cwd(), "../..");
const packagesDir = resolve(repoRoot, "packages");

let packageCache: Promise<PackageDoc[]> | undefined;

function normalizeSlug(packageName: string) {
  return packageName.replace("@guard-sdk/", "");
}

function firstParagraph(readme: string) {
  const lines = readme
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("```"));

  return lines[0] ?? "Package reference for guard-sdk.";
}

function splitNames(csv: string) {
  return csv
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const [left, right] = value.split(/\s+as\s+/);
      return (right ?? left).trim();
    });
}

function collectExportStatements(source: string) {
  const lines = source.split("\n");
  const statements: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();

    if (!line.startsWith("export ")) {
      continue;
    }

    let statement = line;

    while (!statement.trimEnd().endsWith(";") && index < lines.length - 1) {
      index += 1;
      statement += ` ${lines[index].trim()}`;
    }

    statements.push(statement.replace(/\s+/g, " ").trim());
  }

  return statements;
}

function parseExportSymbols(statements: string[]): ApiSymbol[] {
  const symbols: ApiSymbol[] = [];

  for (const statement of statements) {
    const typedReexport = statement.match(/^export\s+type\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/);

    if (typedReexport) {
      for (const name of splitNames(typedReexport[1])) {
        symbols.push({
          kind: "type",
          name,
          declaration: statement,
          source: typedReexport[2],
        });
      }

      continue;
    }

    const reexport = statement.match(/^export\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/);

    if (reexport) {
      for (const name of splitNames(reexport[1])) {
        symbols.push({
          kind: "reexport",
          name,
          declaration: statement,
          source: reexport[2],
        });
      }

      continue;
    }

    const localExport = statement.match(/^export\s+\{([^}]+)\}/);

    if (localExport) {
      for (const name of splitNames(localExport[1])) {
        symbols.push({
          kind: "reexport",
          name,
          declaration: statement,
        });
      }

      continue;
    }

    const reexportAll = statement.match(/^export\s+\*\s+from\s+["']([^"']+)["']/);

    if (reexportAll) {
      symbols.push({
        kind: "reexport",
        name: "*",
        declaration: statement,
        source: reexportAll[1],
      });

      continue;
    }

    const defaultFunction = statement.match(
      /^export\s+default\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/,
    );

    if (defaultFunction) {
      symbols.push({
        kind: "function",
        name: defaultFunction[1],
        declaration: statement,
      });

      continue;
    }

    const defaultClass = statement.match(/^export\s+default\s+class\s+([A-Za-z0-9_$]+)/);

    if (defaultClass) {
      symbols.push({
        kind: "class",
        name: defaultClass[1],
        declaration: statement,
      });

      continue;
    }

    if (statement.match(/^export\s+default\b/)) {
      symbols.push({
        kind: "default",
        name: "default",
        declaration: statement,
      });

      continue;
    }

    const typed = statement.match(/^export\s+type\s+([A-Za-z0-9_$]+)/);

    if (typed) {
      symbols.push({
        kind: "type",
        name: typed[1],
        declaration: statement,
      });
      continue;
    }

    const interfaceSymbol = statement.match(/^export\s+interface\s+([A-Za-z0-9_$]+)/);

    if (interfaceSymbol) {
      symbols.push({
        kind: "interface",
        name: interfaceSymbol[1],
        declaration: statement,
      });
      continue;
    }

    const declaredFunction = statement.match(
      /^export\s+(?:declare\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/,
    );

    if (declaredFunction) {
      symbols.push({
        kind: "function",
        name: declaredFunction[1],
        declaration: statement,
      });
      continue;
    }

    const classSymbol = statement.match(/^export\s+class\s+([A-Za-z0-9_$]+)/);

    if (classSymbol) {
      symbols.push({
        kind: "class",
        name: classSymbol[1],
        declaration: statement,
      });
      continue;
    }

    const constSymbol = statement.match(/^export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/);

    if (constSymbol) {
      symbols.push({
        kind: "const",
        name: constSymbol[1],
        declaration: statement,
      });
      continue;
    }

    symbols.push({
      kind: "unknown",
      name: "export",
      declaration: statement,
    });
  }

  return symbols;
}

async function readPackageDoc(dirName: string): Promise<PackageDoc> {
  const packageRoot = resolve(packagesDir, dirName);
  const packageJsonPath = resolve(packageRoot, "package.json");
  const readmePath = resolve(packageRoot, "README.md");
  const dtsPath = resolve(packageRoot, "src/index.d.ts");
  const tsPath = resolve(packageRoot, "src/index.ts");

  const packageJsonRaw = await readFile(packageJsonPath, "utf8");
  const packageJson = JSON.parse(packageJsonRaw) as PackageJson;

  let readme = "";

  try {
    readme = await readFile(readmePath, "utf8");
  } catch {
    readme = "";
  }

  let apiSource = "";

  try {
    apiSource = await readFile(dtsPath, "utf8");
  } catch {
    apiSource = await readFile(tsPath, "utf8");
  }

  const exportStatements = collectExportStatements(apiSource);
  const dependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) =>
    name.startsWith("@guard-sdk/"),
  );
  const peerDependencies = Object.keys(packageJson.peerDependencies ?? {});

  return {
    slug: normalizeSlug(packageJson.name),
    name: packageJson.name,
    version: packageJson.version ?? "0.0.0",
    description: packageJson.description ?? "No package description available.",
    readmeSummary: firstParagraph(readme),
    internalDependencies: dependencies.sort(),
    peerDependencies: peerDependencies.sort(),
    exportStatements,
    exports: parseExportSymbols(exportStatements),
  };
}

export async function getAllPackageDocs(): Promise<PackageDoc[]> {
  if (!packageCache) {
    packageCache = (async () => {
      const entries = await readdir(packagesDir, { withFileTypes: true });
      const names = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      const docs = await Promise.all(names.map((name) => readPackageDoc(name)));
      return docs.sort((left, right) => left.name.localeCompare(right.name));
    })();
  }

  return packageCache;
}

export async function getPackageDocBySlug(slug: string): Promise<PackageDoc | undefined> {
  const docs = await getAllPackageDocs();
  return docs.find((pkg) => pkg.slug === slug);
}
