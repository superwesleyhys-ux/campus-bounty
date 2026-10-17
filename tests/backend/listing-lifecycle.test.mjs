import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { localConfig, connectionString } from "../../scripts/backend-local.mjs";
import { createStore } from "../../backend/db/store.mjs";
import { createMarket } from "../../backend/modules/market.mjs";
import { taskModule as priorTaskModule } from "../fixtures/pre-listing-lifecycle/tasks.mjs";
import { goodsModule as priorGoodsModule } from "../fixtures/pre-listing-lifecycle/goods.mjs";
import { listingLifecycleModule } from "../../backend/modules/listing-lifecycle.mjs";
import {
  expectedPrior,
  sha256,
  oldInventory,
  preservation,
  upgradeListingLifecycle,
} from "../../scripts/listing-lifecycle-upgrade.mjs";
const key = () => randomUUID();
const taskBody = {
  title: "R12 synthetic bounty",
  category: "Research",
  description: "R12 isolated test scope",
  rewardCents: 1000,
  dueDate: "2027-03-01",
  milestones: [
    {
      title: "R12 deliverable",
      amountCents: 1000,
      deliverable: "R12 report",
      acceptanceCriteria: "R12 evidence",
    },
  ],
};
const productBody = {
  title: "R12 synthetic product",
  description: "R12 isolated test item",
  priceCents: 1000,
  stock: 10,
  deliveryMethods: ["pickup", "shipping"],
  shippingCents: 100,
};
const evidence = new URL(
  "../../.superpowers/sdd/interaction-round12-plan/final-fix-evidence/lifecycle/",
  import.meta.url,
);
async function isolated() {
  const config = localConfig(),
    database = "campus_r12_" + key().replaceAll("-", "");
  const admin = new pg.Client({
    connectionString: connectionString(config, "migrator"),
  });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  const owner = new pg.Client({
    connectionString: connectionString(config, "migrator", database),
  });
  await owner.connect();
  try {
    await owner.query(
      "CREATE SCHEMA campus; CREATE TABLE campus.schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const m of expectedPrior) {
      const sql = await readFile(
        new URL("../../backend/db/migrations/" + m.name, import.meta.url),
        "utf8",
      );
      assert.equal(sha256(sql), m.checksum);
      await owner.query(sql);
      await owner.query(
        "INSERT INTO campus.schema_migrations(name,checksum) VALUES($1,$2)",
        [m.name, m.checksum],
      );
    }
    const store = createStore(
      Object.fromEntries(
        ["app", "auth", "worker"].map((role) => [
          role,
          connectionString(config, role, database),
        ]),
      ),
    );
    await store.verifyRoles();
    const institution = key();
    await owner.query(
      "INSERT INTO campus.institutions VALUES($1,'R12 Synthetic University',true,'R12 isolated fixture')",
      [institution],
    );
    await owner.query(
      "INSERT INTO campus.domains(domain,institution_id,enabled) VALUES('r12.example.test',$1,true)",
      [institution],
    );
    const user = async (name) => {
      const id = key();
      await owner.query(
        "INSERT INTO campus.users(id,display_name) VALUES($1,$2)",
        [id, "R12 " + name],
      );
      await owner.query(
        "INSERT INTO campus.affiliations VALUES($1,$2,'r12.example.test',now()+interval '1 year',true)",
        [id, institution],
      );
      return id;
    };
    return {
      database,
      owner,
      store,
      market: {
        ...createMarket(store),
        ...priorTaskModule(store),
        ...priorGoodsModule(store),
      },
      life: listingLifecycleModule(store),
      user,
      close: async () => {
        await store.close();
        await owner.end();
        await admin.query(`DROP DATABASE ${database}`);
        await admin.end();
      },
    };
  } catch (e) {
    await owner.end();
    await admin.query(`DROP DATABASE ${database}`);
    await admin.end();
    throw e;
  }
}
test("R12 isolated upgrade, immutable versions, consent, lifecycle and stock contracts", async (t) => {
  const f = await isolated();
  try {
    const { owner, store, market, life } = f;
    const publisher = await f.user("Publisher"),
      applicant = await f.user("Applicant"),
      peer = await f.user("Peer"),
      outsider = await f.user("Outsider");
    const publish = (body) =>
      market.publishTask(publisher, body ?? taskBody, key());
    const apply = (task, who = applicant) =>
      market.apply(who, task.id, { proposal: "R12 original proposal" }, key());
    const live = await publish();
    const legacy = await apply(live);
    await market.inviteApplicant(publisher, legacy.id, {}, key());
    const signed = await publish({
      ...taskBody,
      title: "R12 original signed bounty",
    });
    const signedApp = await apply(signed);
    await market.inviteApplicant(publisher, signedApp.id, {}, key());
    const agreement = await market.acceptInvitation(
      applicant,
      signedApp.id,
      {},
      key(),
    );
    const product = await market.publishProduct(publisher, productBody, key());
    const consumed = await market.quote(
      applicant,
      product.id,
      { quantity: 2, deliveryMethod: "pickup" },
      key(),
    );
    const order = await market.order(
      applicant,
      { quoteId: consumed.id },
      key(),
    );
    await market.saveTask(applicant, live.id, {}, key());
    const staleQuote = await market.quote(
      peer,
      product.id,
      { quantity: 1, deliveryMethod: "pickup" },
      key(),
    );
    const beforeTerms = JSON.stringify(agreement.terms),
      beforeOrder = JSON.stringify(order.terms);
    await t.test(
      "001-014 ordinary source operations and all-old-column preservation",
      async () => {
        assert.equal((await market.task(applicant, live.id)).id, live.id);
        assert.equal((await market.getOrder(applicant, order.id)).id, order.id);
        const sql = await readFile(
          new URL(
            "../../backend/db/migrations/015_listing_lifecycle.sql",
            import.meta.url,
          ),
          "utf8",
        );
        const opts = {
          expectedDatabase: f.database,
          expectedMigrationSha: sha256(sql),
          backupDirectory: fileURLToPath(new URL("backups/", evidence)),
        };
        await assert.rejects(
          upgradeListingLifecycle(owner, {
            ...opts,
            expectedDatabase: "campus_development",
          }),
        );
        await assert.rejects(
          upgradeListingLifecycle(owner, {
            ...opts,
            expectedMigrationSha: "0".repeat(64),
          }),
        );
        const report = await upgradeListingLifecycle(owner, opts);
        assert.equal(report.preserved, true);
        assert.equal(
          path.dirname(report.backup.file),
          path.resolve(opts.backupDirectory),
        );
        await mkdir(evidence, { recursive: true });
        await writeFile(
          new URL("upgrade-proof.json", evidence),
          JSON.stringify(report, null, 2),
        );
        assert.equal((await upgradeListingLifecycle(owner, opts)).applied, 0);
        // Continue the upgraded business checks through the current integrated API.
        Object.assign(market, createMarket(store));
        assert.equal(
          (await life.applicationTerms(applicant, legacy.id)).application
            .provenance,
          "legacy_observed_current",
        );
        assert.equal(
          (await life.applicationTerms(applicant, legacy.id)).acknowledgements
            .length,
          0,
        );
        // Old source publish/apply/invite/accept and reads still work in the explicit upgrade window.
        const windowTask = await publish({
          ...taskBody,
          title: "R12 compatibility window",
        });
        const windowApp = await apply(windowTask);
        await market.inviteApplicant(publisher, windowApp.id, {}, key());
        assert.ok(
          (await market.acceptInvitation(applicant, windowApp.id, {}, key()))
            .id,
        );
        assert.equal((await market.products(applicant, {})).items.length, 1);
        assert.equal(
          (await market.agreement(applicant, agreement.id)).terms.taskTitle,
          "R12 original signed bounty",
        );
      },
    );
    await t.test(
      "owner, input, budget, stale forms and response-loss replay",
      async () => {
        const data = {
          expectedRevision: 1,
          terms: { ...taskBody, title: "R12 revised bounty" },
        };
        await assert.rejects(life.editTask(outsider, live.id, data, key()), {
          code: "not_owner",
        });
        await assert.rejects(
          life.editTask(
            publisher,
            live.id,
            { ...data, terms: { ...taskBody, rewardCents: 2000 } },
            key(),
          ),
          { code: "invalid_milestone_budget" },
        );
        const k = key(),
          receipt = await life.editTask(publisher, live.id, data, k);
        assert.equal(receipt.receipt.termsVersion, 2);
        assert.equal(receipt.replayed, false);
        await assert.rejects(life.editTask(publisher, live.id, data, key()), {
          code: "stale_revision",
        });
        const pause = await life.pauseListing(
          publisher,
          "task",
          live.id,
          { expectedRevision: 2 },
          key(),
        );
        assert.equal(pause.current.visibility, "paused");
        const replay = await life.editTask(publisher, live.id, data, k);
        assert.deepEqual(replay.receipt, receipt.receipt);
        assert.equal(replay.replayed, true);
        assert.equal(replay.current.visibility, "paused");
        await assert.rejects(
          life.editTask(publisher, live.id, { ...data, terms: taskBody }, k),
          { code: "idempotency_conflict" },
        );
        assert.equal(
          (await life.listingVersion(publisher, "task", live.id, 1)).terms
            .title,
          taskBody.title,
        );
        assert.equal(
          (await life.listingHistory(publisher, "task", live.id)).length,
          2,
        );
        await assert.rejects(
          owner.query(
            "UPDATE campus.listing_versions SET terms='{}' WHERE kind='task' AND listing_id=$1",
            [live.id],
          ),
          { code: "23514" },
        );
        await assert.rejects(
          store.as(publisher, (c) =>
            c.query("UPDATE campus.tasks SET title=$2 WHERE id=$1", [
              live.id,
              "R12 illegal overwrite",
            ]),
          ),
          { code: "42501" },
        );
        assert.equal(
          (await life.listingCatalog(publisher, "task", { scope: "all" })).some(
            (x) => x.id === live.id,
          ),
          false,
        );
        assert.equal(
          (
            await life.listingCatalog(publisher, "task", { scope: "mine" })
          ).some((x) => x.id === live.id),
          true,
        );
        assert.equal(
          (await life.listingState(applicant, "task", live.id)).visibility,
          "paused",
        );
        await assert.rejects(life.listingState(outsider, "task", live.id), {
          code: "not_found",
        });
        await life.republishListing(
          publisher,
          "task",
          live.id,
          { expectedRevision: 3 },
          key(),
        );
      },
    );
    await t.test(
      "legacy review and stale invitations do not rewrite proposal or consent history",
      async () => {
        let state = await life.applicationTerms(applicant, legacy.id);
        assert.equal(state.reviewRequired, true);
        assert.equal(state.application.proposal, "R12 original proposal");
        await assert.rejects(
          life.acceptApplicationVersion(
            applicant,
            legacy.id,
            { expectedRevision: 4, expectedTermsVersion: 2 },
            key(),
          ),
          { code: "terms_review_required" },
        );
        await life.acknowledgeApplicationTerms(
          applicant,
          legacy.id,
          { expectedRevision: 4, expectedTermsVersion: 2 },
          key(),
        );
        await assert.rejects(
          life.acceptApplicationVersion(
            applicant,
            legacy.id,
            { expectedRevision: 4, expectedTermsVersion: 2 },
            key(),
          ),
          { code: "fresh_invitation_required" },
        );
        await life.inviteApplicationVersion(
          publisher,
          legacy.id,
          { expectedRevision: 4, expectedTermsVersion: 2 },
          key(),
        );
        await life.editTask(
          publisher,
          live.id,
          {
            expectedRevision: 4,
            terms: { ...taskBody, title: "R12 third terms" },
          },
          key(),
        );
        await assert.rejects(
          life.acceptApplicationVersion(
            applicant,
            legacy.id,
            { expectedRevision: 4, expectedTermsVersion: 2 },
            key(),
          ),
          { code: "stale_revision" },
        );
        await assert.rejects(
          life.acceptApplicationVersion(
            applicant,
            legacy.id,
            { expectedRevision: 5, expectedTermsVersion: 3 },
            key(),
          ),
          { code: "terms_review_required" },
        );
        state = await life.applicationTerms(applicant, legacy.id);
        assert.equal(state.acknowledgements.length, 0);
        assert.equal(state.invitations.length, 0);
        const oldAcknowledgements = await life.applicationTermsHistory(
          applicant,
          legacy.id,
          { kind: "acknowledgements" },
        );
        const oldInvitations = await life.applicationTermsHistory(
          applicant,
          legacy.id,
          { kind: "invitations" },
        );
        assert.equal(oldAcknowledgements.items.length, 1);
        assert.equal(oldAcknowledgements.items[0].version, 2);
        assert.equal(oldAcknowledgements.items[0].user_id, applicant);
        assert.equal(oldInvitations.items.length, 1);
        assert.equal(oldInvitations.items[0].version, 2);
        assert.equal(state.currentInvitation, null);
        await life.acknowledgeApplicationTerms(
          applicant,
          legacy.id,
          { expectedRevision: 5, expectedTermsVersion: 3 },
          key(),
        );
        await life.inviteApplicationVersion(
          publisher,
          legacy.id,
          { expectedRevision: 5, expectedTermsVersion: 3 },
          key(),
        );
        const accepted = await life.acceptApplicationVersion(
          applicant,
          legacy.id,
          { expectedRevision: 5, expectedTermsVersion: 3 },
          key(),
        );
        assert.ok(accepted.receipt.agreementId);
        assert.equal(
          (await market.agreement(applicant, accepted.receipt.agreementId))
            .terms.taskTitle,
          "R12 third terms",
        );
        assert.equal(
          (await life.applicationTerms(applicant, legacy.id)).application
            .proposal,
          "R12 original proposal",
        );
      },
    );
    await t.test(
      "signed agreements survive edits and pause; contracted bounty cannot reopen",
      async () => {
        const s = await life.listingState(publisher, "task", signed.id);
        await life.editTask(
          publisher,
          signed.id,
          {
            expectedRevision: s.revision,
            terms: { ...taskBody, title: "R12 future display" },
          },
          key(),
        );
        await life.pauseListing(
          publisher,
          "task",
          signed.id,
          { expectedRevision: s.revision + 1 },
          key(),
        );
        await assert.rejects(
          life.republishListing(
            publisher,
            "task",
            signed.id,
            { expectedRevision: s.revision + 2 },
            key(),
          ),
          { code: "task_contracted" },
        );
        assert.equal(
          JSON.stringify(
            (await market.agreement(applicant, agreement.id)).terms,
          ),
          beforeTerms,
        );
      },
    );
    await t.test(
      "product edits preserve existing orders and invalidate unconsumed quotes",
      async () => {
        const p = await life.listingState(publisher, "product", product.id);
        const edit = {
          expectedRevision: p.revision,
          expectedStock: p.stock,
          expectedStockRevision: p.stock_revision,
          terms: {
            ...productBody,
            title: "R12 revised product",
            stock: p.stock,
            priceCents: 1500,
          },
        };
        await life.editProduct(publisher, product.id, edit, key());
        await assert.rejects(
          market.order(peer, { quoteId: staleQuote.id }, key()),
          { code: "stale_quote" },
        );
        assert.equal(
          (await market.order(applicant, { quoteId: consumed.id }, key())).id,
          order.id,
        );
        assert.equal(
          JSON.stringify((await market.getOrder(applicant, order.id)).terms),
          beforeOrder,
        );
        const q = await market.quote(
          peer,
          product.id,
          { quantity: 1, deliveryMethod: "pickup" },
          key(),
        );
        await life.pauseListing(
          publisher,
          "product",
          product.id,
          { expectedRevision: 2 },
          key(),
        );
        await assert.rejects(market.order(peer, { quoteId: q.id }, key()), {
          code: "stale_quote",
        });
        await assert.rejects(
          market.quote(
            peer,
            product.id,
            { quantity: 1, deliveryMethod: "pickup" },
            key(),
          ),
        );
        await market.cancelOrder(applicant, order.id, {}, key());
        assert.equal(
          (await life.listingState(publisher, "product", product.id)).stock,
          10,
        );
        assert.equal(
          (await market.order(applicant, { quoteId: consumed.id }, key())).id,
          order.id,
        );
        await life.republishListing(
          publisher,
          "product",
          product.id,
          { expectedRevision: 3 },
          key(),
        );
      },
    );
    await t.test(
      "ordinary reservation and cancellation races cannot be overwritten, including ABA stock",
      async () => {
        let p = await life.listingState(publisher, "product", product.id);
        const q = await market.quote(
          peer,
          product.id,
          { quantity: 1, deliveryMethod: "pickup" },
          key(),
        );
        const o = await market.order(peer, { quoteId: q.id }, key());
        await market.cancelOrder(peer, o.id, {}, key());
        assert.equal(
          (await life.listingState(publisher, "product", product.id)).stock,
          p.stock,
        );
        await assert.rejects(
          life.editProduct(
            publisher,
            product.id,
            {
              expectedRevision: p.revision,
              expectedStock: p.stock,
              expectedStockRevision: p.stock_revision,
              terms: { ...productBody, stock: p.stock },
            },
            key(),
          ),
          { code: "stock_changed" },
        );
        p = await life.listingState(publisher, "product", product.id);
        // A concurrent ordinary cancellation must either precede the edit or force its stock conflict.
        const releaseQuote = await market.quote(
          peer,
          product.id,
          { quantity: 1, deliveryMethod: "pickup" },
          key(),
        );
        const releaseOrder = await market.order(
          peer,
          { quoteId: releaseQuote.id },
          key(),
        );
        p = await life.listingState(publisher, "product", product.id);
        const releaseRace = await Promise.allSettled([
          life.editProduct(
            publisher,
            product.id,
            {
              expectedRevision: p.revision,
              expectedStock: p.stock,
              expectedStockRevision: p.stock_revision,
              terms: { ...productBody, stock: p.stock },
            },
            key(),
          ),
          market.cancelOrder(peer, releaseOrder.id, {}, key()),
        ]);
        assert.equal(releaseRace[1].status, "fulfilled");
        if (releaseRace[0].status === "rejected")
          assert.equal(releaseRace[0].reason.code, "stock_changed");
        assert.equal(
          (await life.listingState(publisher, "product", product.id)).stock,
          p.stock + 1,
        );
        p = await life.listingState(publisher, "product", product.id);
        const q2 = await market.quote(
          peer,
          product.id,
          { quantity: 1, deliveryMethod: "pickup" },
          key(),
        );
        const results = await Promise.allSettled([
          life.editProduct(
            publisher,
            product.id,
            {
              expectedRevision: p.revision,
              expectedStock: p.stock,
              expectedStockRevision: p.stock_revision,
              terms: { ...productBody, stock: p.stock },
            },
            key(),
          ),
          market.order(peer, { quoteId: q2.id }, key()),
        ]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        const failure = results.find((r) => r.status === "rejected").reason;
        assert.ok(["stock_changed", "stale_quote"].includes(failure.code));
        if (results[1].status === "fulfilled")
          await market.cancelOrder(peer, results[1].value.id, {}, key());
      },
    );
    await t.test(
      "strict cutover and frozen team consent for exact submission",
      async () => {
        await owner.query(
          "UPDATE campus.listing_lifecycle_cutover SET strict_versions=true",
        );
        const task = await publish({
          ...taskBody,
          title: "R12 explicit team task",
        });
        await assert.rejects(apply(task), {
          status: 409,
          code: "terms_review_required",
        });
        await assert.rejects(
          life.applyVersioned(
            outsider,
            task.id,
            {
              proposal: "R12 stale version",
              expectedRevision: 1,
              expectedTermsVersion: 2,
            },
            key(),
          ),
          { code: "stale_revision" },
        );
        await assert.rejects(
          life.applyVersioned(
            outsider,
            task.id,
            {
              proposal: "R12 stale revision",
              expectedRevision: 2,
              expectedTermsVersion: 1,
            },
            key(),
          ),
          { code: "stale_revision" },
        );
        await assert.rejects(
          life.applyVersioned(
            outsider,
            task.id,
            { proposal: "R12 missing version" },
            key(),
          ),
          { code: "invalid_input" },
        );
        const team = await market.createTeam(
          applicant,
          {
            name: "R12 frozen team",
            context: {
              purpose: "R12 project",
              activities: "R12 research",
              timeCommitment: "R12 2 hours",
              projectContext: "R12 needs",
            },
          },
          key(),
        );
        await market.inviteMember(
          applicant,
          team.id,
          { userId: peer, expectedRevision: team.revision },
          key(),
        );
        await market.acceptMembership(
          peer,
          team.id,
          { expectedRevision: team.revision + 1 },
          key(),
        );
        const a = await life.applyVersioned(
          applicant,
          task.id,
          {
            proposal: "R12 team proposal",
            teamId: team.id,
            expectedRevision: 1,
            expectedTermsVersion: 1,
          },
          key(),
        );
        assert.deepEqual(a.current.missingAcknowledgements, [peer]);
        assert.equal(a.current.application.provenance, "exact_submission");
        await assert.rejects(
          life.inviteApplicationVersion(
            publisher,
            a.receipt.id,
            { expectedRevision: 1, expectedTermsVersion: 1 },
            key(),
          ),
          { code: "terms_review_required" },
        );
        await assert.rejects(
          life.acknowledgeApplicationTerms(
            outsider,
            a.receipt.id,
            { expectedRevision: 1, expectedTermsVersion: 1 },
            key(),
          ),
          { code: "not_found" },
        );
        await life.acknowledgeApplicationTerms(
          peer,
          a.receipt.id,
          { expectedRevision: 1, expectedTermsVersion: 1 },
          key(),
        );
        await life.inviteApplicationVersion(
          publisher,
          a.receipt.id,
          { expectedRevision: 1, expectedTermsVersion: 1 },
          key(),
        );
        await life.editTask(
          publisher,
          task.id,
          {
            expectedRevision: 1,
            terms: { ...taskBody, title: "R12 team edited" },
          },
          key(),
        );
        await life.acknowledgeApplicationTerms(
          peer,
          a.receipt.id,
          { expectedRevision: 2, expectedTermsVersion: 2 },
          key(),
        );
        await assert.rejects(
          life.inviteApplicationVersion(
            publisher,
            a.receipt.id,
            { expectedRevision: 2, expectedTermsVersion: 2 },
            key(),
          ),
          { code: "terms_review_required" },
        );
        await life.acknowledgeApplicationTerms(
          applicant,
          a.receipt.id,
          { expectedRevision: 2, expectedTermsVersion: 2 },
          key(),
        );
        await life.inviteApplicationVersion(
          publisher,
          a.receipt.id,
          { expectedRevision: 2, expectedTermsVersion: 2 },
          key(),
        );
        const accepted = await life.acceptApplicationVersion(
          applicant,
          a.receipt.id,
          { expectedRevision: 2, expectedTermsVersion: 2 },
          key(),
        );
        assert.ok(accepted.receipt.agreementId);
        assert.equal(
          (await life.applicationTerms(peer, a.receipt.id)).members.length,
          2,
        );
      },
    );
    await t.test(
      "ordinary concurrent accepts with reversed applicants share sorted frozen participants",
      async () => {
        // Ordinary services only: two independent tasks, the same two frozen
        // participants, and opposite applicants. No forced waits or lock probes.
        async function prepare(captain, other, label) {
          const task = await publish({
            ...taskBody,
            title: "R12 fix1 " + label,
          });
          const team = await market.createTeam(
            captain,
            {
              name: "R12 fix1 " + label,
              context: {
                purpose: "R12 overlapping participants",
                activities: "R12 ordinary acceptance",
                timeCommitment: "R12 2 hours",
                projectContext: "R12 isolated lock-order regression coverage",
              },
            },
            key(),
          );
          await market.inviteMember(
            captain,
            team.id,
            { userId: other, expectedRevision: team.revision },
            key(),
          );
          await market.acceptMembership(
            other,
            team.id,
            { expectedRevision: team.revision + 1 },
            key(),
          );
          const application = await life.applyVersioned(
            captain,
            task.id,
            {
              proposal: "R12 fix1 explicit proposal",
              teamId: team.id,
              expectedRevision: 1,
              expectedTermsVersion: 1,
            },
            key(),
          );
          await life.acknowledgeApplicationTerms(
            other,
            application.receipt.id,
            { expectedRevision: 1, expectedTermsVersion: 1 },
            key(),
          );
          await life.inviteApplicationVersion(
            publisher,
            application.receipt.id,
            { expectedRevision: 1, expectedTermsVersion: 1 },
            key(),
          );
          return { captain, task, applicationId: application.receipt.id };
        }
        const first = await prepare(applicant, peer, "Applicant A");
        const second = await prepare(peer, applicant, "Applicant B");
        const accepted = await Promise.all(
          [first, second].map(({ captain, applicationId }) =>
            life.acceptApplicationVersion(
              captain,
              applicationId,
              { expectedRevision: 1, expectedTermsVersion: 1 },
              key(),
            ),
          ),
        );
        assert.notEqual(
          accepted[0].receipt.agreementId,
          accepted[1].receipt.agreementId,
        );
        const frozenIds = [applicant, peer].sort();
        for (const [index, item] of accepted.entries()) {
          const agreement = await market.agreement(
            [first, second][index].captain,
            item.receipt.agreementId,
          );
          assert.deepEqual(
            agreement.members.map((m) => m.user_id).sort(),
            frozenIds,
          );
          assert.equal(agreement.task_id, [first, second][index].task.id);
          assert.equal(item.current.application.state, "accepted");
          assert.equal(item.current.missingAcknowledgements.length, 0);
        }
      },
    );
    await t.test(
      "current account eligibility, participant notifications and raw privilege boundaries",
      async () => {
        const task = await publish({ ...taskBody, title: "R12 eligibility" });
        await owner.query(
          "UPDATE campus.users SET account_status='restricted' WHERE id=$1",
          [publisher],
        );
        await assert.rejects(
          life.editTask(
            publisher,
            task.id,
            { expectedRevision: 1, terms: taskBody },
            key(),
          ),
          { code: "account_restricted" },
        );
        await owner.query(
          "UPDATE campus.users SET account_status='active' WHERE id=$1",
          [publisher],
        );
        await owner.query(
          "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
          [publisher],
        );
        await assert.rejects(
          life.pauseListing(
            publisher,
            "task",
            task.id,
            { expectedRevision: 1 },
            key(),
          ),
          { code: "membership_required" },
        );
        await owner.query(
          "UPDATE campus.affiliations SET valid_until=now()+interval '1 year' WHERE user_id=$1",
          [publisher],
        );
        const notices = await store.as(applicant, (c) =>
          c.query(
            "SELECT n.kind,x.* FROM campus.notifications n JOIN campus.listing_notification_context x ON x.notification_id=n.id",
          ),
        );
        assert.ok(
          notices.rows.some(
            (n) =>
              n.kind === "listing.terms_changed" &&
              n.listing_id === live.id &&
              n.terms_version === 2,
          ),
        );
        assert.equal(
          (
            await store.as(outsider, (c) =>
              c.query("SELECT * FROM campus.listing_notification_context"),
            )
          ).rowCount,
          0,
        );
        await assert.rejects(
          store.as(applicant, (c) =>
            c.query(
              "UPDATE campus.listing_lifecycle_cutover SET strict_versions=false",
            ),
          ),
          { code: "42501" },
        );
        for (const role of ["auth", "worker"]) {
          await assert.rejects(
            store[role].query(
              "UPDATE campus.listing_lifecycle_cutover SET strict_versions=false",
            ),
            { code: "42501" },
          );
          await assert.rejects(
            store[role].query(
              "UPDATE campus.application_listing_terms SET provenance='legacy_observed_current'",
            ),
            { code: "42501" },
          );
        }
        await assert.rejects(
          store.as(applicant, (c) =>
            c.query(
              "UPDATE campus.application_listing_terms SET provenance='legacy_observed_current'",
            ),
          ),
          { code: "42501" },
        );
        await owner.query(
          "UPDATE campus.users SET account_status='locked' WHERE id=$1",
          [applicant],
        );
        assert.equal(
          (
            await store.as(applicant, (c) =>
              c.query("SELECT * FROM campus.application_listing_terms"),
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await store.as(applicant, (c) =>
              c.query(
                "SELECT * FROM campus.application_terms_acknowledgements",
              ),
            )
          ).rowCount,
          0,
        );
        await owner.query(
          "UPDATE campus.users SET account_status='active' WHERE id=$1",
          [applicant],
        );
        await assert.rejects(
          store.as(outsider, (c) =>
            c.query("SELECT campus.listing_terms('task',$1)", [live.id]),
          ),
          { code: "42501" },
        );
      },
    );
  } finally {
    await f.close();
  }
});
