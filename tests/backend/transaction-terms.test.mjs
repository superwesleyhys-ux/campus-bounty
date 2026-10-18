import test from "node:test";
import assert from "node:assert/strict";
import {
  isolated,
  key,
  syntheticPolicyPayload,
} from "./transaction-terms-fixture.mjs";
import {
  componentPlan,
  largestRemainder,
  digest,
} from "../../backend/payments/amounts.mjs";
const A = "00000000-0000-4000-8000-000000000001",
  B = "00000000-0000-4000-8000-000000000002";
const body = {
  title: "Transaction terms fixture",
  category: "Research",
  description: "Synthetic acceptance",
  rewardCents: 20000,
  dueDate: "2027-01-01",
  milestones: [
    { title: "Stage 1", amountCents: 10000, deliverable: "First report" },
    { title: "Stage 2", amountCents: 10000, deliverable: "Final report" },
  ],
};
test("production integer allocator: ties, odd fee, multi-stage/lot, zero and insufficient", () => {
  assert.deepEqual(largestRemainder(1, [1, 1], [B, A]), [0, 1]);
  const p = componentPlan({
    members: [
      { memberId: A, units: 6000 },
      { memberId: B, units: 4000 },
    ],
    lots: [
      {
        fundingPlanLotId: "one",
        estimatedProcessorFeeCents: 600,
        stages: [
          { position: 1, milestoneId: "s1", grossCents: 10000 },
          { position: 2, milestoneId: "s2", grossCents: 10000 },
        ],
      },
      {
        fundingPlanLotId: "two",
        estimatedProcessorFeeCents: 301,
        stages: [{ position: 3, milestoneId: "s3", grossCents: 10000 }],
      },
    ],
  });
  assert.deepEqual(
    p.lots[0].components.map((c) => c.netCents),
    [5910, 5910, 3940, 3940],
  );
  assert.equal(p.lots[1].publisherProcessorFeeCents, 151);
  assert.equal(
    p.lots.reduce(
      (s, l) => s + l.components.reduce((n, c) => n + c.netCents, 0),
      0,
    ),
    29550,
  );
  assert.equal(
    p.digest,
    digest(
      Object.fromEntries(Object.entries(p).filter(([k]) => k !== "digest")),
    ),
  );
  assert.deepEqual(largestRemainder(0, [0], ["x"]), [0]);
  assert.throws(() => largestRemainder(1, [0], ["x"]));
  assert.throws(() => largestRemainder(1.5, [1], ["x"]));
  assert.throws(
    () =>
      componentPlan({
        members: [{ memberId: A, units: 10000 }],
        lots: [
          {
            fundingPlanLotId: "x",
            estimatedProcessorFeeCents: 6,
            stages: [{ position: 1, milestoneId: "s", grossCents: 2 }],
          },
        ],
      }),
    /fee_exceeds_component/,
  );
  const cents = (fee) => ({
    members: [
      { memberId: A, units: 5000 },
      { memberId: B, units: 5000 },
    ],
    lots: [
      {
        fundingPlanLotId: "cent-boundary",
        estimatedProcessorFeeCents: fee,
        stages: [
          { position: 1, milestoneId: "position:1", grossCents: 1 },
          { position: 2, milestoneId: "position:2", grossCents: 1 },
        ],
      },
    ],
  });
  const zeroNet = componentPlan(cents(2));
  assert.deepEqual(
    zeroNet.lots[0].components.map((c) => [
      c.grossCents,
      c.recipientFeeCents,
      c.netCents,
    ]),
    [
      [1, 1, 0],
      [1, 0, 1],
      [0, 0, 0],
      [0, 0, 0],
    ],
  );
  assert.throws(
    () => componentPlan(cents(4)),
    (e) => e.code === "fee_exceeds_component",
    "zero-gross member cannot absorb positive fee",
  );
  for (const bad of [
    -1,
    NaN,
    Infinity,
    100000001,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const gross = cents(null);
    gross.lots[0].stages[0].grossCents = bad;
    assert.throws(
      () => componentPlan(gross),
      (e) => e.code === "invalid_amount",
    );
    assert.throws(
      () => componentPlan(cents(bad)),
      (e) => e.code === "invalid_amount",
    );
  }
  const overflow = cents(null);
  overflow.lots[0].stages.forEach((s) => (s.grossCents = 60000000));
  assert.throws(
    () => componentPlan(overflow),
    (e) => e.code === "invalid_amount",
    "aggregate stage sum bounded",
  );
  const charge = cents(2);
  charge.lots[0].stages = [
    { position: 1, milestoneId: "s", grossCents: 100000000 },
  ];
  assert.throws(
    () => componentPlan(charge),
    (e) => e.code === "invalid_amount",
    "charge including publisher fee bounded",
  );
});
test("real 001–017 service fixtures upgrade; immutable consent, both acceptance paths, compatibility", async () => {
  const f = await isolated();
  try {
    const m = f.market,
      P = await f.user("Publisher"),
      C = await f.user("Captain"),
      M = await f.user("Member"),
      O = await f.user("Other");
    const old = await m.publishTask(P, body, key());
    const oa = await m.apply(C, old.id, { proposal: "Legacy" }, key());
    await m.inviteApplicant(P, oa.id, {}, key());
    const og = await m.acceptInvitation(C, oa.id, {}, key());
    assert.equal((await m.capabilities(P)).transactionTerms, false);
    const before = (
      await f.owner.query("SELECT terms FROM campus.agreements WHERE id=$1", [
        og.id,
      ])
    ).rows[0].terms;
    await f.migrateThrough(18);
    assert.deepEqual(
      (
        await f.owner.query("SELECT terms FROM campus.agreements WHERE id=$1", [
          og.id,
        ])
      ).rows[0].terms,
      before,
    );
    assert.equal((await m.agreement(P, og.id)).transaction.releasePolicy, null);
    await assert.rejects(
      m.publishTask(P, body, key()),
      (e) => e.code === "release_policy_required",
    );
    const team = await m.createTeam(
      C,
      {
        name: "Ratios Team",
        context: {
          purpose: "Research",
          activities: "Read sources",
          timeCommitment: "One hour",
          projectContext: "",
        },
      },
      key(),
    );
    await m.inviteMember(
      C,
      team.id,
      { userId: M, expectedRevision: team.revision },
      key(),
    );
    await m.acceptMembership(
      M,
      team.id,
      { expectedRevision: (await m.team(M, team.id)).revision },
      key(),
    );
    for (const [i, mode] of ["per_milestone", "final_completion"].entries()) {
      const t = await m.publishTask(P, { ...body, releasePolicy: mode }, key());
      const a = await m.applyVersioned(
        C,
        t.id,
        {
          proposal: "Exact proposed work",
          teamId: i ? null : team.id,
          expectedTermsVersion: t.terms_version,
          expectedRevision: t.revision,
        },
        key(),
      );
      const aid = a.receipt.id;
      const members = i ? [C] : [C, M];
      for (const actor of members)
        await m.acknowledgeApplicationTerms(
          actor,
          aid,
          {
            expectedTermsVersion: t.terms_version,
            expectedRevision: t.revision,
          },
          key(),
        );
      const request = {
        expectedTermsVersion: t.terms_version,
        expectedRevision: t.revision,
        expectedAllocationRevision: 0,
        ratios: members.map((id, j) => ({
          userId: id,
          ratioUnits: i ? 10000 : j ? 4000 : 6000,
        })),
        ratioDenominator: 10000,
        policyVersionId: null,
      };
      const k = key();
      let r = await m.proposeAllocation(C, aid, request, k);
      assert.equal(
        r.current.current.plan.lots[0].estimatedProcessorFeeCents,
        null,
      );
      assert.equal(
        (await m.proposeAllocation(C, aid, request, k)).replayed,
        true,
      );
      assert.equal(
        (await m.proposeAllocation(C, aid, request, key())).receipt.id,
        r.receipt.id,
      );
      await assert.rejects(m.proposeAllocation(O, aid, request, key()));
      await assert.rejects(
        m.proposeAllocation(
          C,
          aid,
          { ...request, ratios: [{ userId: O, ratioUnits: 10000 }] },
          key(),
        ),
      );
      const confirm = (x) => ({
        expectedRevision: x.task_revision,
        expectedTermsVersion: x.listing_version,
        allocationDigest: x.digest,
      });
      for (const actor of [...members, P])
        await m.confirmAllocation(
          actor,
          aid,
          r.current.current.revision,
          confirm(r.current.current),
          key(),
        );
      await m.inviteApplicationVersion(
        P,
        aid,
        { expectedTermsVersion: t.terms_version, expectedRevision: t.revision },
        key(),
      );
      await assert.rejects(
        m.acceptInvitation(C, aid, {}, key()),
        (e) => e.code === "fee_policy_pending",
      );
      await assert.rejects(
        m.acceptApplicationVersion(
          C,
          aid,
          {
            expectedTermsVersion: t.terms_version,
            expectedRevision: t.revision,
          },
          key(),
        ),
        (e) => e.code === "fee_policy_pending",
      );
      // Owner-managed, application-scoped synthetic policy. Not a production/provider fee approval.
      const policy = key();
      await f.owner.query(
        "INSERT INTO campus.payment_policy_versions(id,application_id,listing_version,status,provenance,payload) VALUES($1,$2,$3,'approved','Task2A synthetic test only',$4)",
        [
          policy,
          aid,
          t.terms_version,
          JSON.stringify(syntheticPolicyPayload()),
        ],
      );
      const previous = r.current.current;
      r = await m.proposeAllocation(
        C,
        aid,
        { ...request, expectedAllocationRevision: 1, policyVersionId: policy },
        key(),
      );
      assert.equal(r.current.current.revision, 2);
      assert.deepEqual(
        r.current.current.policy_snapshot.payload,
        syntheticPolicyPayload(),
      );
      assert.equal(r.current.financialConsentAvailable, true);
      const saved = r.current.current;
      assert.equal(
        saved.digest,
        digest({
          applicationId: aid,
          allocationRevision: saved.revision,
          listingVersion: saved.listing_version,
          taskRevision: saved.task_revision,
          releasePolicy: mode,
          policyId: policy,
          policySnapshot: saved.policy_snapshot,
          plan: saved.plan,
        }),
      );
      await assert.rejects(
        f.owner.query(
          "UPDATE campus.payment_policy_versions SET payload=payload-'disclosure' WHERE id=$1",
          [policy],
        ),
        (e) => e.code === "23514",
      );
      assert.equal(
        r.current.confirmations.filter((c) => c.allocation_id === r.receipt.id)
          .length,
        0,
      );
      await assert.rejects(
        m.confirmAllocation(
          M,
          aid,
          previous.revision,
          confirm(previous),
          key(),
        ),
      );
      await assert.rejects(
        m.acceptInvitation(C, aid, {}, key()),
        (e) => e.code === "financial_consent_required",
      );
      for (const actor of [...members, P])
        await m.confirmAllocation(
          actor,
          aid,
          r.current.current.revision,
          confirm(r.current.current),
          key(),
        );
      const g = i
        ? await m.acceptInvitation(C, aid, {}, key())
        : (
            await m.acceptApplicationVersion(
              C,
              aid,
              {
                expectedTermsVersion: t.terms_version,
                expectedRevision: t.revision,
              },
              key(),
            )
          ).agreement;
      const detail = await m.agreement(P, g.id);
      assert.equal(detail.transaction.releasePolicy, mode);
      assert.deepEqual(
        detail.transaction.terms[0].policy_snapshot,
        r.current.current.policy_snapshot,
      );
      assert.equal(
        detail.transaction.allocations.reduce((s, c) => s + c.gross_cents, 0),
        20000,
      );
      assert.equal(
        detail.transaction.allocations.reduce(
          (s, c) => s + c.recipient_fee_cents,
          0,
        ),
        300,
      );
      assert.equal(detail.state, "awaiting_funding");
      await assert.rejects(
        f.store.as(C, (c) =>
          c.query(
            "DELETE FROM campus.application_allocation_confirmations WHERE application_id=$1",
            [aid],
          ),
        ),
        (e) => e.code === "42501",
      );
    }

    const t = await m.publishTask(
      P,
      { ...body, releasePolicy: "per_milestone" },
      key(),
    );
    const app = await m.applyVersioned(
      C,
      t.id,
      {
        proposal: "Stale and authority",
        teamId: null,
        expectedRevision: t.revision,
        expectedTermsVersion: t.terms_version,
      },
      key(),
    );
    const id = app.receipt.id;
    const req = {
      expectedRevision: t.revision,
      expectedTermsVersion: t.terms_version,
      expectedAllocationRevision: 0,
      ratios: [{ userId: C, ratioUnits: 10000 }],
      ratioDenominator: 10000,
      policyVersionId: null,
    };
    const forged = componentPlan({
      members: [{ memberId: C, units: 10000 }],
      lots: [
        {
          fundingPlanLotId: key(),
          estimatedProcessorFeeCents: null,
          stages: [
            { position: 1, milestoneId: "position:1", grossCents: 9999 },
            { position: 2, milestoneId: "position:2", grossCents: 10000 },
          ],
        },
      ],
    });
    await assert.rejects(
      f.store.as(C, (c) =>
        c.query("SELECT campus.propose_application_allocation($1,$2)", [
          id,
          JSON.stringify({
            expectedRevision: 1,
            expectedTermsVersion: 1,
            expectedAllocationRevision: 0,
            ratios: [{ memberId: C, units: 10000 }],
            policyId: null,
            plan: forged,
          }),
        ]),
      ),
      (e) => e.message === "invalid_component_plan",
    );
    assert.equal((await m.applicationAllocation(C, id)).history.length, 0);
    const commandKey = key(),
      r = await m.proposeAllocation(C, id, req, commandKey);
    await assert.rejects(
      m.proposeAllocation(C, id, { ...req, expectedRevision: 999 }, commandKey),
      (e) => e.code === "idempotency_conflict",
    );
    await assert.rejects(
      m.proposeAllocation(
        C,
        id,
        {
          ...req,
          ratioDenominator: 100,
          ratios: [{ userId: C, ratioUnits: 100 }],
        },
        key(),
      ),
    );
    await assert.rejects(
      m.proposeAllocation(
        C,
        id,
        { ...req, ratios: [{ userId: C, ratioUnits: 0 }] },
        key(),
      ),
    );
    await assert.rejects(
      m.confirmAllocation(
        O,
        id,
        1,
        {
          expectedRevision: 1,
          expectedTermsVersion: 1,
          allocationDigest: r.current.current.digest,
        },
        key(),
      ),
    );
    const foreign = (
      await f.owner.query(
        "SELECT id FROM campus.payment_policy_versions LIMIT 1",
      )
    ).rows[0].id;
    await assert.rejects(
      m.proposeAllocation(
        C,
        id,
        { ...req, expectedAllocationRevision: 1, policyVersionId: foreign },
        key(),
      ),
      (e) => e.status === 404,
    );
    await m.editTask(
      P,
      t.id,
      {
        expectedRevision: 1,
        terms: { ...body, releasePolicy: "final_completion" },
      },
      key(),
    );
    await assert.rejects(
      m.confirmAllocation(
        C,
        id,
        1,
        {
          expectedRevision: 1,
          expectedTermsVersion: 1,
          allocationDigest: r.current.current.digest,
        },
        key(),
      ),
      (e) => e.code === "stale_revision",
    );
    await assert.rejects(
      m.proposeAllocation(C, id, req, key()),
      (e) => e.code === "stale_revision",
    );
    const changed = await m.proposeAllocation(
      C,
      id,
      {
        ...req,
        expectedRevision: 2,
        expectedTermsVersion: 2,
        expectedAllocationRevision: 1,
      },
      key(),
    );
    assert.equal(changed.current.current.revision, 2);
    assert.notEqual(changed.current.current.digest, r.current.current.digest);
    assert.equal(changed.current.confirmations.length, 0);
    assert.equal(
      (await m.listingVersion(P, "task", t.id, 1)).terms.releasePolicy,
      "per_milestone",
    );
    assert.equal(
      (await m.listingVersion(P, "task", t.id, 2)).terms.releasePolicy,
      "final_completion",
    );
    await assert.rejects(
      f.owner.query(
        "UPDATE campus.application_allocation_revisions SET digest=$1 WHERE id=$2",
        ["x", changed.receipt.id],
      ),
      (e) => e.code === "23514",
    );
    assert.equal(
      (
        await f.store.as(O, (c) =>
          c.query(
            "SELECT * FROM campus.application_allocation_revisions WHERE application_id=$1",
            [id],
          ),
        )
      ).rowCount,
      0,
    );
    for (const [amount, weights, keys] of [
      [1, [1, 1], ["b", "a"]],
      [0, [0], ["a"]],
      [150, [6000, 4000], ["a", "b"]],
      [1, [1, 1], ["0000000002:b", "0000000001:a"]],
    ]) {
      const sql = (
        await f.owner.query(
          "SELECT campus.transaction_lr($1,$2,$3) AS result",
          [amount, weights, keys],
        )
      ).rows[0].result.map(Number);
      assert.deepEqual(sql, largestRemainder(amount, weights, keys));
    }

    // Full service + independent SQL plan authority for two one-cent stages.
    const tinyTask = await m.publishTask(
      P,
      {
        ...body,
        rewardCents: 2,
        releasePolicy: "per_milestone",
        milestones: body.milestones.map((v) => ({ ...v, amountCents: 1 })),
      },
      key(),
    );
    const tinyApp = (
      await m.applyVersioned(
        C,
        tinyTask.id,
        {
          proposal: "Cent boundary",
          teamId: team.id,
          expectedRevision: 1,
          expectedTermsVersion: 1,
        },
        key(),
      )
    ).receipt.id;
    const tinyMembers = [C, M]
      .sort()
      .map((memberId) => ({ memberId, units: 5000 }));
    const tinyRequest = {
      expectedRevision: 1,
      expectedTermsVersion: 1,
      expectedAllocationRevision: 0,
      ratios: tinyMembers.map((v) => ({
        userId: v.memberId,
        ratioUnits: v.units,
      })),
      ratioDenominator: 10000,
      policyVersionId: null,
    };
    async function scenario(payload) {
      const policyId = key();
      await f.owner.query(
        "INSERT INTO campus.payment_policy_versions(id,application_id,listing_version,status,provenance,payload) VALUES($1,$2,1,'approved','Fix1 isolated synthetic only',$3)",
        [policyId, tinyApp, JSON.stringify(payload)],
      );
      return policyId;
    }
    for (const mutate of [
      (p) => {
        delete p.disclosure;
      },
      (p) => {
        p.disclosure.tax.description = " ";
      },
      (p) => {
        p.disclosure.refund.version = 1;
      },
      (p) => {
        p.disclosure.feeAdjustment.policyId = "foreign-reference";
      },
    ]) {
      const payload = syntheticPolicyPayload(2, 2);
      mutate(payload);
      const invalid = await scenario(payload);
      await assert.rejects(
        m.proposeAllocation(
          C,
          tinyApp,
          { ...tinyRequest, policyVersionId: invalid },
          key(),
        ),
        (e) => e.code === "policy_disclosure_pending",
      );
      await assert.rejects(
        f.owner.query("SELECT campus.transaction_plan($1,$2,$3,$4)", [
          tinyApp,
          JSON.stringify(tinyMembers),
          key(),
          invalid,
        ]),
        (e) => e.message === "policy_disclosure_pending",
      );
      const projection = await m.applicationAllocation(C, tinyApp);
      assert.equal(projection.current, null);
      assert.equal(projection.financialConsentAvailable, false);
      assert.equal(
        projection.policies.find((p) => p.id === invalid).disclosure_ready,
        false,
      );
    }
    for (const badFee of [4, -1, NaN, 100000001]) {
      const invalid = await scenario(syntheticPolicyPayload(badFee, 2));
      await assert.rejects(
        m.proposeAllocation(
          C,
          tinyApp,
          { ...tinyRequest, policyVersionId: invalid },
          key(),
        ),
        (e) =>
          e.code ===
          (badFee === 4
            ? "fee_exceeds_component"
            : Number.isNaN(badFee)
              ? "invalid_input"
              : "invalid_amount"),
      );
      await assert.rejects(
        f.owner.query("SELECT campus.transaction_plan($1,$2,$3,$4)", [
          tinyApp,
          JSON.stringify(tinyMembers),
          key(),
          invalid,
        ]),
        (e) =>
          e.message ===
          (badFee === 4 ? "fee_exceeds_component" : "invalid_input"),
      );
      assert.equal(
        (await m.applicationAllocation(C, tinyApp)).history.length,
        0,
      );
    }
    const valid = await scenario(syntheticPolicyPayload(2, 2));
    const tiny = await m.proposeAllocation(
      C,
      tinyApp,
      { ...tinyRequest, policyVersionId: valid },
      key(),
    );
    const actual = tiny.current.current.plan;
    const expected = componentPlan({
      members: tinyMembers,
      lots: [
        {
          fundingPlanLotId: actual.lots[0].fundingPlanLotId,
          estimatedProcessorFeeCents: 2,
          stages: [
            { position: 1, milestoneId: "position:1", grossCents: 1 },
            { position: 2, milestoneId: "position:2", grossCents: 1 },
          ],
        },
      ],
    });
    assert.deepEqual(actual, expected);
    assert.deepEqual(
      actual.lots[0].components.map((c) => [
        c.grossCents,
        c.recipientFeeCents,
        c.netCents,
      ]),
      [
        [1, 1, 0],
        [1, 0, 1],
        [0, 0, 0],
        [0, 0, 0],
      ],
    );
    assert.deepEqual(
      (
        await f.owner.query(
          "SELECT campus.transaction_plan($1,$2,$3,$4) AS plan",
          [
            tinyApp,
            JSON.stringify(tinyMembers),
            actual.lots[0].fundingPlanLotId,
            valid,
          ],
        )
      ).rows[0].plan,
      expected,
    );
    for (const actor of [C, M])
      await m.acknowledgeApplicationTerms(
        actor,
        tinyApp,
        { expectedRevision: 1, expectedTermsVersion: 1 },
        key(),
      );
    for (const actor of [C, M, P])
      await m.confirmAllocation(
        actor,
        tinyApp,
        1,
        {
          expectedRevision: 1,
          expectedTermsVersion: 1,
          allocationDigest: tiny.current.current.digest,
        },
        key(),
      );
    await m.inviteApplicationVersion(
      P,
      tinyApp,
      { expectedRevision: 1, expectedTermsVersion: 1 },
      key(),
    );
    const tinyAgreement = (
      await m.acceptApplicationVersion(
        C,
        tinyApp,
        { expectedRevision: 1, expectedTermsVersion: 1 },
        key(),
      )
    ).agreement;
    const tinyDetail = await m.agreement(P, tinyAgreement.id);
    assert.equal(tinyDetail.state, "awaiting_funding");
    assert.equal(
      tinyDetail.transaction.allocations.filter((c) => c.net_cents === 0)
        .length,
      3,
    );
    assert.equal(
      tinyDetail.transaction.allocations.reduce(
        (sum, c) => sum + c.net_cents,
        0,
      ),
      1,
    );
    const grants = (
      await f.owner.query(
        "SELECT has_table_privilege('campus_app','campus.application_allocation_revisions','INSERT') AS write,has_function_privilege('campus_worker','campus.confirm_application_allocation(uuid,jsonb)','EXECUTE') AS impersonate",
      )
    ).rows[0];
    assert.equal(grants.write, false);
    assert.equal(grants.impersonate, false);
  } finally {
    await f.close();
  }
});
