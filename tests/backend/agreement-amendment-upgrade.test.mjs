import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import {
  isolated,
  scenario,
  key,
  evidence,
  journal,
  draft,
  consent,
  taskBody,
} from "./agreement-amendments-fixture.mjs";
import { createMarket as legacyMarket } from "../fixtures/pre-agreement-amendments/backend/modules/market.mjs";
import {
  upgradeAgreementAmendments,
  sha256,
  oldInventory,
  preservation,
} from "../../scripts/agreement-amendment-upgrade.mjs";
const error = (c) => (e) => e.code === c;

test("real exact archive restore and additive017 cutover preserve001–016 rows, legacy receipts and staged writers", async () => {
  const f = await isolated({ version: 16 }),
    restore = await isolated({ empty: true });
  const legacy = legacyMarket(f.store);
  const m = f.market;
  try {
    const a = await scenario(f, {
      market: legacy,
      active: true,
      team: true,
      versioned: true,
      editedBeforeAcceptance: true,
    });
    const oldSubmit = {
        content: "  Legacy ordinary submission  ",
        expectedVersion: 0,
        expectedRevision: 1,
      },
      submitKey = key();
    const submitted = await legacy.submitMilestone(
      a.A,
      a.agreement.milestones[0].id,
      oldSubmit,
      submitKey,
    );
    const oldReview = {
        submissionId: submitted.submission.id,
        expectedVersion: submitted.milestone.version,
        expectedRevision: submitted.milestone.revision,
        feedback: "  Add evidence  ",
      },
      reviewKey = key();
    const reviewed = await legacy.requestMilestoneRevision(
      a.P,
      a.agreement.milestones[0].id,
      oldReview,
      reviewKey,
    );
    // Staged source is genuinely run against016: capability discovery cannot query017 tables.
    assert.deepEqual(await m.capabilities(a.P), {
      agreementAmendments: false,
      agreementTermsBinding: "legacy",
      schemaRequirement: 17,
    });
    assert.equal(
      (await m.agreement(a.P, a.agreement.id)).effectiveTerms,
      undefined,
    );
    await assert.rejects(
      m.agreementTerms(a.P, a.agreement.id),
      error("agreement_amendments_unavailable"),
    );
    const b = await scenario(f, {
      market: m,
      versioned: false,
      editedBeforeAcceptance: true,
      team: true,
      active: true,
    });
    const stagedRequest = {
      content: "Staged old-schema work",
      expectedVersion: 0,
      expectedRevision: 1,
    };
    const staged = await m.submitMilestone(
      b.A,
      b.agreement.milestones[0].id,
      stagedRequest,
      key(),
    );
    assert.equal(staged.submission.submissionTermsId, undefined);
    // A category-only post-acceptance edit repeats every signed field at v3.
    // Exact versioned receipt still proves a accepted v2; ordinary receipt alone
    // cannot disambiguate the same history for unknown, so its source stays null.
    const unknown = await scenario(f, {
      market: legacy,
      team: true,
      editedBeforeAcceptance: true,
    });
    for (const item of [a, unknown]) {
      const current = await legacy.task(item.P, item.task.id);
      await legacy.editTask(
        item.P,
        item.task.id,
        {
          expectedRevision: current.revision,
          terms: {
            ...structuredClone(taskBody),
            category: "Other",
            title: "R13 accepted v2",
            description: "Accepted revised description",
            dueDate: "2027-03-02",
          },
        },
        key(),
      );
    }
    // A second ordinary acceptance after preliminary observation demonstrates the
    // gate's real cutoff inventory includes transition-created rows, not an earlier list.
    const preliminary = (
      await f.owner.query("SELECT count(*)::int n FROM campus.agreements")
    ).rows[0].n;
    const transition = await scenario(f, { market: legacy, team: true });
    const owned = new Set([...f.ownedDatabases, ...restore.ownedDatabases]);
    const migrationSha = sha256(
      await readFile(
        new URL(
          "../../backend/db/migrations/017_agreement_amendments.sql",
          import.meta.url,
        ),
      ),
    );
    const options = {
      expectedDatabase: f.database,
      expectedMigrationSha: migrationSha,
      backupDirectory: fileURLToPath(new URL("backups/", evidence)),
      restoreClient: restore.owner,
      restoreDatabase: restore.database,
      ownedDatabases: owned,
    };
    const proof = await upgradeAgreementAmendments(f.owner, options);
    assert.equal(proof.applied, 1);
    assert.equal(proof.before.agreements.rows, preliminary + 1);
    assert.deepEqual(proof.before, proof.after);
    assert.deepEqual(proof.before, proof.restored);
    assert.equal(
      (await m.agreement(a.P, a.agreement.id)).originalTerms.origin,
      "legacy_snapshot",
    );
    assert.equal(
      (await m.agreement(transition.P, transition.agreement.id)).originalTerms
        .origin,
      "legacy_snapshot",
    );
    for (const [item, source] of [
      [a, 2],
      [b, 2],
      [unknown, null],
    ]) {
      const actual = await m.agreement(item.P, item.agreement.id);
      assert.deepEqual(actual.terms, item.agreement.terms);
      const restored = (
        await restore.owner.query(
          "SELECT g.terms,a.submitted_version FROM campus.agreements g JOIN campus.application_listing_terms a ON a.application_id=g.application_id WHERE g.id=$1",
          [item.agreement.id],
        )
      ).rows[0];
      assert.deepEqual(restored.terms, item.agreement.terms);
      assert.equal(restored.submitted_version, 1);
      for (const terms of [actual.originalTerms, actual.effectiveTerms]) {
        assert.equal(terms.sourceListingVersion, source);
        assert.deepEqual(terms.terms, item.agreement.terms);
        assert.equal(terms.terms.taskTitle, "R13 accepted v2");
      }
      assert.equal(
        (
          await f.owner.query(
            "SELECT submitted_version FROM campus.application_listing_terms WHERE application_id=$1",
            [item.app.id],
          )
        ).rows[0].submitted_version,
        1,
      );
    }
    const originalSub = (
      await m.submissions(a.P, a.agreement.milestones[0].id)
    )[0];
    assert.equal(
      originalSub.termsProvenance,
      "legacy_original_snapshot_binding",
    );
    assert.equal(originalSub.submissionTermsRevision, 1);
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM campus.agreement_amendment_confirmations",
        )
      ).rows[0].n,
      0,
    );
    assert.deepEqual(await upgradeAgreementAmendments(f.owner, options), {
      applied: 0,
      replay: true,
      database: f.database,
    });
    // Disabled017 accepts missing fields only under unchanged T1, with honest current provenance.
    const c = await scenario(f, { active: true, versioned: true, team: true });
    const disabledBody = {
        content: "Disabled017 original work",
        expectedVersion: 0,
        expectedRevision: 1,
      },
      disabledKey = key();
    const disabled = await m.submitMilestone(
      c.A,
      c.agreement.milestones[0].id,
      disabledBody,
      disabledKey,
    );
    assert.equal(
      disabled.submission.termsProvenance,
      "legacy_client_original_binding",
    );
    assert.equal(c.agreement.originalTerms.origin, "accepted_application");
    // Both acceptance methods still initialize exactly one T1 after017.
    const d = await scenario(f, { team: true });
    assert.equal(d.agreement.originalTerms.origin, "accepted_application");
    await f.enable();
    for (const [item, source] of [
      [a, 2],
      [b, 2],
      [unknown, null],
    ]) {
      const current = await m.agreement(item.P, item.agreement.id),
        body = draft(current);
      body.terms.dueDate = "2027-04-03";
      const proposed = await m.proposeAmendment(
        item.A,
        current.id,
        body,
        key(),
      );
      const detail = await m.agreementAmendment(
        item.P,
        current.id,
        proposed.amendment.id,
      );
      assert.equal(detail.baseTerms.sourceListingVersion, source);
      assert.equal(detail.proposedTerms.sourceListingVersion, source);
    }
    const recovery = await m.submitMilestone(
      a.A,
      a.agreement.milestones[0].id,
      oldSubmit,
      submitKey,
    );
    assert.deepEqual(recovery.receipt, submitted.receipt);
    assert.equal(recovery.submission.id, submitted.submission.id);
    const reviewRecovery = await m.requestMilestoneRevision(
      a.P,
      a.agreement.milestones[0].id,
      oldReview,
      reviewKey,
    );
    assert.deepEqual(reviewRecovery.receipt, reviewed.receipt);
    assert.deepEqual(
      (
        await m.submitMilestone(
          c.A,
          c.agreement.milestones[0].id,
          disabledBody,
          disabledKey,
        )
      ).receipt,
      disabled.receipt,
    );
    await assert.rejects(
      m.submitMilestone(
        a.A,
        a.agreement.milestones[0].id,
        {
          content: "Fresh old client",
          expectedVersion: 1,
          expectedRevision: 3,
        },
        key(),
      ),
      error("terms_refresh_required"),
    );
    await assert.rejects(
      m.acceptMilestone(
        b.P,
        b.agreement.milestones[0].id,
        {
          submissionId: staged.submission.id,
          expectedVersion: 1,
          expectedRevision: 2,
        },
        key(),
      ),
      error("terms_refresh_required"),
    );
    await assert.rejects(
      f.store.as(b.P, (db) =>
        db.query(
          "SELECT campus.review_milestone_work($1,$2,1,2,'accepted','')",
          [b.agreement.milestones[0].id, staged.submission.id],
        ),
      ),
      (e) => e.message === "terms_refresh_required",
    );
    // Successful command recovery remains available after mutation capability is disabled.
    let g = await m.agreement(d.P, d.agreement.id);
    const proposal = draft(g);
    proposal.terms.dueDate = "2027-04-01";
    const proposalKey = key();
    const p = await m.proposeAmendment(d.A, g.id, proposal, proposalKey);
    const detail = await m.agreementAmendment(d.P, g.id, p.amendment.id);
    for (const actor of [d.P, d.A, d.B])
      await m.confirmAmendment(actor, g.id, detail.id, consent(detail), key());
    await f.owner.query(
      "UPDATE campus.agreement_amendment_settings SET mutations_enabled=false WHERE singleton",
    );
    const recovered = await m.proposeAmendment(
      d.A,
      g.id,
      proposal,
      proposalKey,
    );
    assert.deepEqual(recovered.receipt, p.receipt);
    assert.equal(recovered.amendment.status, "effective");
    assert.equal((await m.agreement(d.P, g.id)).effectiveTerms.revision, 2);
    await assert.rejects(
      m.proposeAmendment(d.A, g.id, proposal, key()),
      error("agreement_amendments_unavailable"),
    );
    // Pure validator rejection; no raw contradictory business rows inserted.
    const valid = await f.owner.query(
      `SELECT campus.validate_legacy_agreement_snapshot(g.terms,(SELECT jsonb_agg(jsonb_build_object('position',position,'title',title,'amount_cents',amount_cents,'deliverable',deliverable,'acceptance_criteria',acceptance_criteria) ORDER BY position) FROM campus.milestones WHERE agreement_id=g.id),(SELECT array_agg(user_id ORDER BY user_id) FROM campus.agreement_members WHERE agreement_id=g.id),g.captain_id,g.owner_id) AS valid,campus.validate_legacy_agreement_snapshot(g.terms||'{"rewardCents":999999}'::jsonb,(SELECT jsonb_agg(to_jsonb(m) ORDER BY position) FROM campus.milestones m WHERE agreement_id=g.id),(SELECT array_agg(user_id ORDER BY user_id) FROM campus.agreement_members WHERE agreement_id=g.id),g.captain_id,g.owner_id) AS invalid FROM campus.agreements g WHERE id=$1`,
      [a.agreement.id],
    );
    assert.deepEqual(valid.rows[0], { valid: true, invalid: false });
    await writeFile(
      new URL("upgrade-" + f.database + ".json", evidence),
      JSON.stringify(
        {
          ...proof,
          preliminaryAgreements: preliminary,
          transitionAgreementId: transition.agreement.id,
          legacyAgreementId: a.agreement.id,
          stagedAgreementId: b.agreement.id,
          acceptedSourceEvidence: [
            {
              agreementId: a.agreement.id,
              path: "versioned exact receipt; repeated signed snapshot at v3",
              submitted: 1,
              accepted: 2,
              current: 2,
              candidate: 2,
            },
            {
              agreementId: b.agreement.id,
              path: "ordinary receipt; unique signed v2 plus invitation and all acknowledgements",
              submitted: 1,
              accepted: 2,
              current: 2,
              candidate: 2,
            },
            {
              agreementId: unknown.agreement.id,
              path: "ordinary receipt; repeated signed snapshot at v3 is ambiguous",
              submitted: 1,
              accepted: null,
              current: null,
              candidate: null,
            },
          ],
          legacySource:
            "tests/fixtures/pre-agreement-amendments/provenance.json",
          validatorScope:
            "pure function; contradictory business rows not created",
          oldReceiptRecovery: true,
          synthetic_activation: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await f.close();
    await restore.close();
  }
});
