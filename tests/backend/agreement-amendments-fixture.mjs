import pg from "pg";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, appendFile } from "node:fs/promises";
import { localConfig, connectionString } from "../../scripts/backend-local.mjs";
import {
  expectedPrior,
  sha256,
} from "../../scripts/agreement-amendment-upgrade.mjs";
import { createStore } from "../../backend/db/store.mjs";
import { createMarket } from "../../backend/modules/market.mjs";
export const evidence = new URL(
  "../../.superpowers/sdd/interaction-round13-plan/task-2-fix1-evidence/",
  import.meta.url,
);
export const key = randomUUID;
export async function journal(value) {
  await mkdir(evidence, { recursive: true });
  await appendFile(
    new URL("databases.jsonl", evidence),
    JSON.stringify({ at: new Date().toISOString(), ...value }) + "\n",
  );
}
export async function isolated({ version = 17, empty = false } = {}) {
  const config = localConfig(),
    database = "campus_r13_" + key().replaceAll("-", ""),
    ownedDatabases = new Set();
  const admin = new pg.Client({
    connectionString: connectionString(config, "migrator"),
  });
  await admin.connect();
  await admin.query("CREATE DATABASE " + database);
  ownedDatabases.add(database);
  await journal({
    database,
    action: "created",
    purpose: empty ? "restore" : "services",
    version,
  });
  const owner = new pg.Client({
    connectionString: connectionString(config, "migrator", database),
  });
  await owner.connect();
  let store;
  const close = async () => {
    await store?.close();
    await owner.end();
    assert.ok(ownedDatabases.has(database));
    await admin.query("DROP DATABASE " + database + " WITH (FORCE)");
    await journal({ database, action: "dropped" });
    await admin.end();
  };
  try {
    if (!empty) {
      await owner.query(
        "CREATE SCHEMA campus; CREATE TABLE campus.schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
      );
      for (const m of [
        ...expectedPrior,
        ...(version === 17 ? [{ name: "017_agreement_amendments.sql" }] : []),
      ]) {
        const sql = await readFile(
          new URL("../../backend/db/migrations/" + m.name, import.meta.url),
          "utf8",
        );
        if (m.checksum) assert.equal(sha256(sql), m.checksum);
        await owner.query("BEGIN");
        try {
          await owner.query(sql);
          await owner.query(
            "INSERT INTO campus.schema_migrations(name,checksum) VALUES($1,$2)",
            [m.name, sha256(sql)],
          );
          await owner.query("COMMIT");
        } catch (e) {
          await owner.query("ROLLBACK");
          throw e;
        }
      }
      store = createStore(
        Object.fromEntries(
          ["app", "auth", "worker"].map((r) => [
            r,
            connectionString(config, r, database),
          ]),
        ),
      );
      await store.verifyRoles();
    }
    const institution = key();
    if (!empty) {
      await owner.query(
        "INSERT INTO campus.institutions VALUES($1,'R13 Synthetic University',true,'Isolated R13 only')",
        [institution],
      );
      await owner.query(
        "INSERT INTO campus.domains VALUES('r13.example.test',$1,true)",
        [institution],
      );
    }
    return {
      database,
      owner,
      store,
      config,
      ownedDatabases,
      close,
      market: store ? createMarket(store) : null,
      async user(name) {
        const id = key();
        await owner.query(
          "INSERT INTO campus.users(id,display_name) VALUES($1,$2)",
          [id, "R13 " + name],
        );
        await owner.query(
          "INSERT INTO campus.affiliations VALUES($1,$2,'r13.example.test',now()+interval '1 year',true)",
          [id, institution],
        );
        return id;
      },
      async activate(id) {
        assert.ok(ownedDatabases.has(database));
        const r = await owner.query(
          "UPDATE campus.agreements SET state='active' WHERE id=$1 AND state='awaiting_funding'",
          [id],
        );
        assert.equal(r.rowCount, 1);
        await journal({
          database,
          agreementId: id,
          synthetic_activation: true,
        });
      },
      async enable() {
        await owner.query(
          "UPDATE campus.agreement_amendment_settings SET mutations_enabled=true,strict_binding=true WHERE singleton",
        );
      },
    };
  } catch (e) {
    await close();
    throw e;
  }
}
export const taskBody = {
  title: "R13 synthetic bounty",
  category: "Research",
  description: "Isolated agreement test",
  rewardCents: 1000,
  dueDate: "2027-03-01",
  milestones: [
    {
      title: "M1",
      amountCents: 400,
      deliverable: "Dataset",
      acceptanceCriteria: "Citations",
    },
    {
      title: "M2",
      amountCents: 600,
      deliverable: "Report",
      acceptanceCriteria: "Analysis",
    },
  ],
};
export async function scenario(
  f,
  {
    market = f.market,
    versioned = false,
    active = false,
    team = false,
    editedBeforeAcceptance = false,
  } = {},
) {
  const P = await f.user("P"),
    A = await f.user("A"),
    B = team ? await f.user("B") : null,
    O = await f.user("O");
  let teamId = null;
  if (team) {
    const t = await market.createTeam(
      A,
      {
        name: "R13 team",
        context: {
          purpose: "Research",
          activities: "Read sources",
          timeCommitment: "One hour",
          projectContext: "",
        },
      },
      key(),
    );
    teamId = t.id;
    const invite = await market.inviteMember(
      A,
      teamId,
      { userId: B, expectedRevision: t.revision },
      key(),
    );
    const detail = await market.team(B, teamId);
    await market.acceptMembership(
      B,
      teamId,
      { expectedRevision: detail.revision },
      key(),
    );
  }
  const task = await market.publishTask(P, structuredClone(taskBody), key());
  const app = await market.apply(
    A,
    task.id,
    { proposal: "R13 plan", teamId },
    key(),
  );
  if (B) await market.consentApplication(B, app.id, {}, key());
  if (editedBeforeAcceptance) {
    const current = await market.task(P, task.id);
    await market.editTask(
      P,
      task.id,
      {
        expectedRevision: current.revision,
        terms: {
          ...structuredClone(taskBody),
          title: "R13 accepted v2",
          description: "Accepted revised description",
          dueDate: "2027-03-02",
        },
      },
      key(),
    );
  }
  let agreement;
  if (versioned || editedBeforeAcceptance) {
    const t = await market.task(P, task.id);
    for (const actor of [A, B].filter(Boolean))
      await market.acknowledgeApplicationTerms(
        actor,
        app.id,
        { expectedTermsVersion: t.terms_version, expectedRevision: t.revision },
        key(),
      );
    await market.inviteApplicationVersion(
      P,
      app.id,
      { expectedTermsVersion: t.terms_version, expectedRevision: t.revision },
      key(),
    );
    if (versioned) {
      const r = await market.acceptApplicationVersion(
        A,
        app.id,
        { expectedTermsVersion: t.terms_version, expectedRevision: t.revision },
        key(),
      );
      agreement = { id: r.receipt.agreementId };
    } else agreement = await market.acceptInvitation(A, app.id, {}, key());
  } else {
    await market.inviteApplicant(P, app.id, {}, key());
    agreement = await market.acceptInvitation(A, app.id, {}, key());
  }
  if (active) await f.activate(agreement.id);
  return {
    P,
    A,
    B,
    O,
    task,
    app,
    agreement: await market.agreement(P, agreement.id),
    market,
  };
}
export function draft(g) {
  return {
    expectedEffectiveTermsId: g.effectiveTerms.id,
    expectedEffectiveRevision: g.effectiveTerms.revision,
    terms: {
      taskTitle: g.effectiveTerms.terms.taskTitle,
      description: g.effectiveTerms.terms.description,
      dueDate: g.effectiveTerms.terms.dueDate ?? null,
      rewardCents: g.effectiveTerms.terms.rewardCents,
      currency: "USD",
      milestones: structuredClone(g.effectiveTerms.milestones),
      retireMilestoneIds: [],
    },
    reason: "R13 explicit proposal",
  };
}
export function consent(p) {
  return {
    expectedEffectiveTermsId: p.baseTerms.id,
    expectedEffectiveRevision: p.baseTerms.revision,
    expectedProposalRevision: p.proposalRevision,
    proposedTermsId: p.proposedTerms.id,
    proposedTermsRevision: p.proposedTerms.revision,
  };
}
