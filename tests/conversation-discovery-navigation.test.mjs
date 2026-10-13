import test from "node:test";
import assert from "node:assert/strict";
import { notificationHref } from "../src/components/shared/notification-types.ts";
const messageId = "a44515c7-f6ae-4892-9431-8f597f18c975";
const targetId = "fa5df690-d1a7-42b6-b22f-ef04a401b4ec";
const item = (type) => ({
  kind: "message.received",
  targetAvailable: true,
  target: { type, id: targetId },
  navigationAnchor: null,
  messageContext: { messageId },
});
for (const type of ["agreement", "order"]) {
  test(`${type} notification selects the exact message within its own scope`, () => {
    const link = new URL(notificationHref(item(type)), "https://example.test");
    assert.equal(link.searchParams.get("resource"), type);
    assert.equal(link.searchParams.get("id"), targetId);
    assert.equal(link.searchParams.get("messageId"), messageId);
    assert.equal(link.hash, "");
  });
}
test("unresolved message notification retains generic authorized target navigation", () => {
  for (const type of ["agreement", "order"]) {
    const link = new URL(
      notificationHref({ ...item(type), messageContext: null }),
      "https://example.test",
    );
    assert.equal(link.searchParams.get("id"), targetId);
    assert.equal(link.searchParams.has("messageId"), false);
  }
});
test("unavailable targets never receive a navigation URL", () => {
  assert.equal(
    notificationHref({ ...item("agreement"), targetAvailable: false }),
    null,
  );
  assert.equal(notificationHref({ ...item("order"), target: null }), null);
});
test("submission and review links retain exact milestone navigation", () => {
  for (const reviewId of [null, "0a5df690-d1a7-42b6-b22f-ef04a401b4ec"]) {
    const link = new URL(
      notificationHref({
        ...item("agreement"),
        kind: "milestone.submitted",
        messageContext: null,
        navigationAnchor: {
          type: "milestone",
          submissionId: messageId,
          reviewId,
        },
      }),
      "https://example.test",
    );
    assert.equal(
      link.hash,
      reviewId ? "#review-" + reviewId : "#submission-" + messageId,
    );
    assert.equal(link.searchParams.has("messageId"), false);
  }
});
