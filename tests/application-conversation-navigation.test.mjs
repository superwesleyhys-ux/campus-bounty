import test from "node:test";
import assert from "node:assert/strict";
import { notificationHref } from "../src/components/shared/notification-types.ts";
import { conversationRole } from "../src/components/shared/conversation-types.ts";
const target = {
  type: "application",
  id: "app-exact",
  taskId: "task-available",
};
const item = {
  kind: "message.received",
  targetAvailable: true,
  target,
  messageContext: { messageId: "message-old" },
};
test("application message notifications open exact history and message even when task is available", () => {
  const url = new URL(notificationHref(item), "https://example.test");
  assert.equal(url.searchParams.get("resource"), "application");
  assert.equal(url.searchParams.get("id"), target.id);
  assert.equal(url.searchParams.get("messageId"), "message-old");
  assert.equal(url.hash, "");
});
test("application actions preserve bounty navigation and private-history fallback", () => {
  assert.equal(
    notificationHref({ ...item, kind: "application.invited" }),
    "/?view=bounties&id=task-available#application-app-exact",
  );
  assert.equal(
    notificationHref({
      ...item,
      kind: "application.invited",
      target: { type: "application", id: target.id },
    }),
    "/?view=workspace&tab=applications&resource=application&id=app-exact#application-app-exact",
  );
});
test("unresolved application message retains exact discussion without inventing a message", () => {
  assert.equal(
    notificationHref({ ...item, messageContext: null }),
    "/?view=workspace&tab=applications&resource=application&id=app-exact",
  );
  assert.equal(notificationHref({ ...item, targetAvailable: false }), null);
});
test("application roles do not imply signed collaboration", () => {
  assert.equal(conversationRole("applicant"), "Applicant");
  assert.equal(
    conversationRole("proposed_participant"),
    "Proposed participant",
  );
  assert.equal(conversationRole("participant"), "Signed participant");
});
