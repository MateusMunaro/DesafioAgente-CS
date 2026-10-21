/**
 * Keeps docs/casos-de-teste.md honest: every case in the table must point at files that exist and at a test whose
 * title carries the same id, and every row of the decision matrix must point at known cases.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const DOC = readFileSync(path.join(ROOT, "docs/casos-de-teste.md"), "utf8");

/** Rows of the markdown table whose first cell matches `idPattern`. */
function rows(idPattern: RegExp): string[][] {
  return DOC.split("\n")
    .filter((l) => l.startsWith("|"))
    .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()))
    .filter((cells) => idPattern.test(cells[0] ?? ""));
}

const filesIn = (cell: string): string[] => [...cell.matchAll(/`([^`]+\.ts)`/g)].map((m) => m[1] as string);

/** True when some it/test/describe title in `source` contains `id` (also after it.each([...])(...)). */
function hasTestTitled(source: string, id: string): boolean {
  const title = new RegExp(`(?:\\b(?:it|test|describe)(?:\\.\\w+)?\\(|\\)\\()\\s*[\`"'][^\`"'\\n]*\\b${id}\\b`);
  return title.test(source);
}

const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

describe("docs/casos-de-teste.md", () => {
  const cases = rows(/^TC-\d\d$/);

  it("lists TC-01..TC-23 with no gaps and no duplicates", () => {
    expect(cases.map((c) => c[0])).toEqual(Array.from({ length: 23 }, (_, i) => `TC-${String(i + 1).padStart(2, "0")}`));
  });

  it.each(cases.map((c) => [c[0] as string, c] as const))("%s: every referenced file exists and a test with the same id exists", (id, cells) => {
    expect(cells).toHaveLength(5);
    const files = filesIn(cells[4] ?? "");
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(existsSync(path.join(ROOT, f)), `${f} does not exist`).toBe(true);
    expect(
      files.some((f) => hasTestTitled(read(f), id)),
      `no test titled with ${id} in ${files.join(", ")}`,
    ).toBe(true);
    // the first file listed is the end-to-end one and must carry the id itself
    expect(hasTestTitled(read(files[0] as string), id), `${files[0]} has no test titled ${id}`).toBe(true);
  });

  it("covers every row of the decision matrix (14 situations) with cases that exist", () => {
    const matrix = DOC.split("## Cobertura da matriz de decisão")[1]?.split("\n## ")[0] ?? "";
    const matrixRows = matrix
      .split("\n")
      .filter((l) => l.startsWith("|") && !l.startsWith("| ---") && !l.startsWith("| Situa"))
      .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
    expect(matrixRows).toHaveLength(14);

    const known = new Set([
      ...cases.map((c) => c[0] as string),
      ...rows(/^CV-\d\d$/).map((c) => c[0] as string),
      ...[...DOC.matchAll(/^\| (RT-\d\d) \|/gm)].map((m) => m[1] as string),
    ]);
    for (const row of matrixRows) {
      const ids = (row[2] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      expect(ids.length, `matrix row without cases: ${row[0]}`).toBeGreaterThan(0);
      for (const id of ids) expect(known.has(id), `${id} (matrix row "${row[0]}") is not documented`).toBe(true);
    }
  });

  it("every CV and RT id has a test titled with it", () => {
    const conversations = read("apps/agent/test/scenarios/conversations.scenarios.test.ts");
    const redteam = read("apps/agent/test/scenarios/redteam.scenarios.test.ts");
    for (const c of rows(/^CV-\d\d$/)) expect(hasTestTitled(conversations, c[0] as string), c[0]).toBe(true);
    for (const m of DOC.matchAll(/^\| (RT-\d\d) \|/gm)) expect(hasTestTitled(redteam, m[1] as string), m[1]).toBe(true);
  });
});
