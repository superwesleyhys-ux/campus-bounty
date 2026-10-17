import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID as key } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fixture } from "./fixture.mjs";
import { createStore } from "../../backend/db/store.mjs";
import { createMarket } from "../../backend/modules/market.mjs";
import { endpoint } from "../../backend/http/endpoint.mjs";
const task = {
  title: "R12 integration bounty",
  category: "Research",
  description: "R12 only isolated evidence",
  rewardCents: 1000,
  dueDate: "2027-03-01",
  milestones: [
    {
      title: "R12 report",
      deliverable: "R12 document",
      acceptanceCriteria: "Reproducible",
      amountCents: 1000,
    },
  ],
};
const product = {
  title: "R12 integration product",
  description: "R12 only",
  priceCents: 1000,
  stock: 10,
  deliveryMethods: ["pickup", "shipping"],
  shippingCents: 100,
};
const expect = (fn, code) =>
  assert.rejects(
    async () => fn(),
    (e) => e.code === code,
  );
test("R12 integrated strict service and exact HTTP contracts", async (t) => {
  const f = await fixture(),
    store = createStore(f.urls),
    m = createMarket(store);
  try {
    const publisher = await f.user("R12 Publisher"),
      applicant = await f.user("R12 Applicant"),
      peer = await f.user("R12 Peer"),
      outsider = await f.user("R12 Outsider");
    const legacyTask = await m.publishTask(publisher, task, key());
    const legacy = await m.apply(
      applicant,
      legacyTask.id,
      { proposal: "R12 original unchanged" },
      key(),
    );
    await f.owner.query(
      "UPDATE campus.listing_lifecycle_cutover SET strict_versions=true",
    );
    await t.test(
      "strict legacy version1 review, fresh invitation and unchanged original proposal",
      async () => {
        const d = await m.applicationTerms(applicant, legacy.id);
        assert.equal(d.application.provenance, "unversioned_submission");
        assert.equal(d.legacyProvenance, true);
        assert.deepEqual(d.missingAcknowledgements, [applicant]);
        await expect(
          () => m.inviteApplicant(publisher, legacy.id, {}, key()),
          "terms_review_required",
        );
        await expect(
          () => m.apply(peer, legacyTask.id, { proposal: "old format" }, key()),
          "terms_review_required",
        );
        const input = { expectedRevision: 1, expectedTermsVersion: 1 };
        await m.acknowledgeApplicationTerms(applicant, legacy.id, input, key());
        await m.inviteApplicationVersion(publisher, legacy.id, input, key());
        const accepted = await m.acceptApplicationVersion(
          applicant,
          legacy.id,
          input,
          key(),
        );
        assert.ok(accepted.receipt.agreementId);
        const agreement = await m.agreement(
          applicant,
          accepted.receipt.agreementId,
        );
        const state = await m.listingState(publisher, "task", legacyTask.id);
        await m.editTask(
          publisher,
          legacyTask.id,
          {
            expectedRevision: state.revision,
            terms: { ...task, title: "R12 edited after agreement" },
          },
          key(),
        );
        assert.deepEqual(
          (await m.agreement(applicant, agreement.id)).terms,
          agreement.terms,
        );
        assert.equal(
          (await m.applicationTerms(applicant, legacy.id)).application.proposal,
          "R12 original unchanged",
        );
      },
    );
    let team, listing, app;
    await t.test(
      "all frozen participants, repeated changes, bounded histories and outsider denial",
      async () => {
        team = await m.createTeam(
          applicant,
          {
            name: "R12 team",
            context: {
              purpose: "R12 review",
              activities: "R12 tasks",
              timeCommitment: "R12 hour",
              projectContext: "",
            },
          },
          key(),
        );
        await m.inviteMember(
          applicant,
          team.id,
          { userId: peer, expectedRevision: team.revision },
          key(),
        );
        team = (await m.teams(peer)).find((x) => x.id === team.id);
        await m.acceptMembership(
          peer,
          team.id,
          { expectedRevision: team.revision },
          key(),
        );
        listing = await m.publishTask(publisher, task, key());
        app = await m.applyVersioned(
          applicant,
          listing.id,
          {
            proposal: "R12 frozen proposal",
            teamId: team.id,
            expectedRevision: 1,
            expectedTermsVersion: 1,
          },
          key(),
        );
        const id = app.receipt.id;
        for (let v = 1; v <= 12; v++) {
          const current = await m.applicationTerms(applicant, id),
            input = {
              expectedRevision: current.listing.revision,
              expectedTermsVersion: current.listing.terms_version,
            };
          if (v > 1)
            await m.acknowledgeApplicationTerms(applicant, id, input, key());
          await expect(
            () => m.inviteApplicationVersion(publisher, id, input, key()),
            "terms_review_required",
          );
          await m.acknowledgeApplicationTerms(peer, id, input, key());
          await m.inviteApplicationVersion(publisher, id, input, key());
          const reviewed = await m.applicationTerms(peer, id);
          assert.equal(reviewed.acknowledgements.length, 2);
          assert.equal(reviewed.invitations.length, 1);
          assert.equal(reviewed.reviewRequired, false);
          if (v < 12)
            await m.editTask(
              publisher,
              listing.id,
              {
                expectedRevision: input.expectedRevision,
                terms: { ...task, title: `R12 version ${v + 1}` },
              },
              key(),
            );
        }
        const h = await m.applicationTermsHistory(applicant, id, {
          kind: "acknowledgements",
          limit: 5,
        });
        assert.equal(h.items.length, 5);
        assert.ok(h.next);
        const h2 = await m.applicationTermsHistory(applicant, id, {
          kind: "acknowledgements",
          limit: 5,
          ...h.next,
        });
        assert.equal(h2.items.length, 5);
        assert.notDeepEqual(h.items, h2.items);
        const inv = await m.applicationTermsHistory(publisher, id, {
          kind: "invitations",
          limit: 5,
        });
        assert.equal(inv.items.length, 5);
        assert.ok(inv.next);
        assert.equal(
          (
            await m.applicationTermsHistory(publisher, id, {
              kind: "invitations",
              limit: 5,
              ...inv.next,
            })
          ).items.length,
          5,
        );
        await expect(
          () =>
            m.applicationTermsHistory(outsider, id, {
              kind: "acknowledgements",
            }),
          "not_found",
        );
        await expect(() => m.applicationTerms(outsider, id), "not_found");
        const exact = await m.applicationTerms(applicant, id),
          input = {
            expectedRevision: exact.listing.revision,
            expectedTermsVersion: exact.listing.terms_version,
          };
        await m.editTask(
          publisher,
          listing.id,
          {
            expectedRevision: input.expectedRevision,
            terms: { ...task, title: "R12 another review invalidated" },
          },
          key(),
        );
        await expect(
          () => m.acceptApplicationVersion(applicant, id, input, key()),
          "stale_revision",
        );
      },
    );
    await t.test(
      "catalog pause, authorized history, stale edits and replay current state",
      async () => {
        const row = await m.listingState(publisher, "task", listing.id),
          body = { expectedRevision: row.revision },
          k = key();
        await m.pauseListing(publisher, "task", listing.id, body, k);
        assert.equal(
          (await m.tasks(publisher, {})).items.some((x) => x.id === listing.id),
          false,
        );
        assert.equal(
          (await m.tasks(publisher, { scope: "mine" })).items.some(
            (x) => x.id === listing.id,
          ),
          true,
        );
        assert.equal(
          (await m.task(applicant, listing.id)).visibility,
          "paused",
        );
        await expect(() => m.task(outsider, listing.id), "not_found");
        await m.republishListing(
          publisher,
          "task",
          listing.id,
          { expectedRevision: row.revision + 1 },
          key(),
        );
        const replay = await m.pauseListing(
          publisher,
          "task",
          listing.id,
          body,
          k,
        );
        assert.equal(replay.replayed, true);
        assert.equal(replay.receipt.visibility, "paused");
        assert.equal(replay.current.visibility, "published");
        await expect(
          () =>
            m.editTask(
              publisher,
              listing.id,
              { expectedRevision: row.revision, terms: task },
              key(),
            ),
          "stale_revision",
        );
        const notices = await m.notifications(applicant, {});
        assert.ok(
          notices.items.some(
            (n) =>
              n.listingContext?.id === listing.id &&
              n.title !== "Activity update",
          ),
        );
      },
    );
    await t.test(
      "displayed quote version, reservation stock ABA, consumed quote replay after pause",
      async () => {
        let p = await m.publishProduct(publisher, product, key());
        await expect(
          () =>
            m.quoteVersioned(
              applicant,
              p.id,
              { quantity: 1, deliveryMethod: "pickup" },
              key(),
            ),
          "invalid_input",
        );
        const quote = await m.quoteVersioned(
          applicant,
          p.id,
          {
            quantity: 1,
            deliveryMethod: "pickup",
            expectedRevision: p.revision,
            expectedTermsVersion: p.terms_version,
          },
          key(),
        );
        const order = await m.order(applicant, { quoteId: quote.id }, key());
        await expect(
          () =>
            m.editProduct(
              publisher,
              p.id,
              {
                expectedRevision: p.revision,
                expectedStock: p.stock,
                expectedStockRevision: p.stock_revision,
                terms: product,
              },
              key(),
            ),
          "stock_changed",
        );
        await m.cancelOrder(applicant, order.id, {}, key());
        await expect(
          () =>
            m.editProduct(
              publisher,
              p.id,
              {
                expectedRevision: p.revision,
                expectedStock: p.stock,
                expectedStockRevision: p.stock_revision,
                terms: product,
              },
              key(),
            ),
          "stock_changed",
        );
        p = await m.product(publisher, p.id);
        await m.editProduct(
          publisher,
          p.id,
          {
            expectedRevision: p.revision,
            expectedStock: p.stock,
            expectedStockRevision: p.stock_revision,
            terms: { ...product, priceCents: 1200 },
          },
          key(),
        );
        await expect(
          () =>
            m.quoteVersioned(
              peer,
              p.id,
              {
                quantity: 1,
                deliveryMethod: "pickup",
                expectedRevision: 1,
                expectedTermsVersion: 1,
              },
              key(),
            ),
          "stale_revision",
        );
        await m.pauseListing(
          publisher,
          "product",
          p.id,
          { expectedRevision: 2 },
          key(),
        );
        assert.equal(
          (await m.products(publisher, {})).items.some((x) => x.id === p.id),
          false,
        );
        assert.equal(
          (await m.order(applicant, { quoteId: quote.id }, key())).id,
          order.id,
        );
        assert.deepEqual(
          (await m.getOrder(applicant, order.id)).terms,
          order.terms,
        );
      },
    );
    await t.test(
      "actual handler source uses strict schemas and boundary guards",
      async () => {
        const runtime = {
          market: m,
          config: {
            origin: "http://127.0.0.1:3020",
            cookieName: "campus_session",
          },
          auth: {
            resolve: async (token) => {
              assert.ok([publisher, applicant, peer, outsider].includes(token));
              return { id: token };
            },
            limitBusiness: async () => {},
          },
        };
        const handlers = new Map();
        async function call(
          route,
          who,
          body,
          params = {},
          method = "POST",
          extra = {},
        ) {
          if (!handlers.has(route)) {
            const source = (
              await readFile(
                new URL(
                  "../../src/app/api/v1/" + route + "/route.js",
                  import.meta.url,
                ),
                "utf8",
              )
            ).replace(
              'import { api } from "@/lib/backend.mjs";',
              "const api=globalThis.__r12Api;",
            );
            globalThis.__r12Api = (options, run) =>
              endpoint(async () => runtime, options, run);
            handlers.set(
              route,
              await import(
                "data:text/javascript;base64," +
                  Buffer.from(source).toString("base64")
              ),
            );
            delete globalThis.__r12Api;
          }
          const req = new Request("http://127.0.0.1:3020/api/v1/test", {
            method,
            headers: {
              host: "127.0.0.1:3020",
              origin: "http://127.0.0.1:3020",
              "content-type": "application/json",
              cookie: `campus_session=${who}`,
              "idempotency-key": key(),
              ...extra,
            },
            ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
          });
          const res = await handlers
            .get(route)
            [method](req, { params: Promise.resolve(params) });
          return { status: res.status, data: await res.json() };
        }
        const p = await m.publishTask(publisher, task, key());
        assert.equal(
          (
            await call(
              "tasks/[id]/applications",
              applicant,
              { proposal: "R12 missing versions" },
              { id: p.id },
            )
          ).status,
          422,
        );
        const apply = await call(
          "tasks/[id]/applications",
          applicant,
          {
            proposal: "R12 HTTP exact",
            expectedRevision: 1,
            expectedTermsVersion: 1,
          },
          { id: p.id },
        );
        assert.equal(apply.status, 201);
        assert.equal(
          apply.data.current.application.provenance,
          "exact_submission",
        );
        assert.equal(
          (
            await call(
              "tasks/[id]/edit",
              outsider,
              { expectedRevision: 1, terms: task },
              { id: p.id },
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await call(
              "tasks/[id]/edit",
              publisher,
              { expectedRevision: 1, terms: task },
              { id: p.id },
              "POST",
              { origin: "https://bad.example" },
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await call(
              "applications/[id]/consent",
              applicant,
              {},
              { id: apply.data.receipt.id },
            )
          ).status,
          422,
        );
        const invited = await call(
          "applications/[id]/invitation",
          publisher,
          { expectedRevision: 1, expectedTermsVersion: 1 },
          { id: apply.data.receipt.id },
        );
        assert.equal(invited.status, 200);
        const accepted = await call(
          "applications/[id]/acceptance",
          applicant,
          { expectedRevision: 1, expectedTermsVersion: 1 },
          { id: apply.data.receipt.id },
        );
        assert.equal(accepted.status, 200);
        assert.ok(accepted.data.receipt.agreementId);
      },
    );
  } finally {
    await store.close();
    await f.close();
  }
});
