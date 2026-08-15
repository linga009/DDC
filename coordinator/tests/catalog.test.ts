import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelCatalog } from "../src/catalog.ts";

test("default catalog has four tiers with increasing thresholds, tier 0 always available", () => {
  const catalog = new ModelCatalog();
  const result = catalog.availability(0);

  assert.equal(result.length, 4);
  assert.equal(result[0].minActiveNodes, 0);
  assert.equal(result[0].available, true);
  assert.equal(result[1].available, false);
  assert.equal(result[2].available, false);
  assert.equal(result[3].available, false);
});

test("models unlock exactly at their threshold, not one below", () => {
  const catalog = new ModelCatalog([
    { id: "small", displayName: "Small", minActiveNodes: 0 },
    { id: "medium", displayName: "Medium", minActiveNodes: 3 },
  ]);

  assert.equal(catalog.availability(2).find(e => e.id === "medium")!.available, false);
  assert.equal(catalog.availability(3).find(e => e.id === "medium")!.available, true);
  assert.equal(catalog.availability(4).find(e => e.id === "medium")!.available, true);
});

test("custom catalog entries are used verbatim, replacing the default table", () => {
  const catalog = new ModelCatalog([
    { id: "only-one", displayName: "Only One", minActiveNodes: 5 },
  ]);

  const result = catalog.availability(10);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "only-one");
});
