//src/lib/guide.test.ts
/** guide.test.ts — garantit que l'exemple JSON de ADD_ELEMENTS.md reste valide et ne référence que des effets existants. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CompositionS } from "./schema";
import { registry } from "@/effects";
import { layoutDoc, validate } from "./engine";

describe("ADD_ELEMENTS.md", () => {
  const md = readFileSync(process.cwd() + "/ADD_ELEMENTS.md", "utf8");
  const block = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]).find((b) => b.includes('"v": 2')) ?? "";
  it("l'exemple complet valide le schéma", () => { expect(() => CompositionS.parse(JSON.parse(block))).not.toThrow(); });
  it("aucun avertissement : tous les effets cités existent", () => {
    const doc = CompositionS.parse(JSON.parse(block));
    expect(validate(doc, (id) => registry.has(id), layoutDoc(doc))).toEqual([]);
  });
});
