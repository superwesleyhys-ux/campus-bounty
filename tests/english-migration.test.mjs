import test from "node:test";
import assert from "node:assert/strict";
import { seed } from "../src/lib/seed.mjs";
import replacements from "../src/lib/migrations/english-demo.json" with { type: "json" };
import { migrateEnglishDemo } from "../src/lib/migrations/english-demo.mjs";

test("English demo migration preserves user content, workflow state and orders", () => {
  const data = seed();
  delete data.demoCopyLocale;
  for (const [group, entries] of Object.entries(replacements)) {
    for (const { id, fields } of entries) {
      const item = data[group].find((record) => record.id === id);
      for (const [field, [previous]] of Object.entries(fields))
        item[field] = structuredClone(previous);
    }
  }
  data.tasks[0].status = "active";
  data.tasks[0].assigneeId = "student";
  data.tasks[0].messages.push({ body: "A user's own message" });
  data.tasks[1].description = "A custom description the user has edited.";
  data.products[0].status = "reserved";
  data.orders.push({
    id: "order",
    productId: "goods-1",
    title: data.products[0].title,
    price: 16000,
    status: "awaiting_delivery",
  });
  const originalPrice = data.products[0].price;
  assert.equal(migrateEnglishDemo(data), true);
  assert.equal(data.tasks[0].title, seed().tasks[0].title);
  assert.equal(data.tasks[0].category, "Research");
  assert.equal(data.tasks[0].status, "active");
  assert.equal(data.tasks[0].assigneeId, "student");
  assert.deepEqual(data.tasks[0].messages, [{ body: "A user's own message" }]);
  assert.equal(
    data.tasks[1].description,
    "A custom description the user has edited.",
  );
  assert.equal(data.products[0].status, "reserved");
  assert.equal(data.products[0].price, originalPrice);
  assert.equal(data.orders[0].title, seed().products[0].title);
  const once = JSON.stringify(data);
  assert.equal(migrateEnglishDemo(data), false);
  assert.equal(JSON.stringify(data), once);
});
