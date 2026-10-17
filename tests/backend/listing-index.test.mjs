import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID as key, createHash } from "node:crypto";
import {
  readFile,
  writeFile,
  readdir,
  mkdir,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import { migrate } from "../../backend/db/migrate.mjs";
import { createStore } from "../../backend/db/store.mjs";
import { createMarket } from "../../backend/modules/market.mjs";
import {
  oldInventory,
  preservation,
} from "../../scripts/listing-lifecycle-upgrade.mjs";

const root = new URL("../../", import.meta.url);
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
const task = {
  title: "R12 index proof",
  category: "Research",
  description: "R12 isolated history",
  rewardCents: 1000,
  dueDate: "2027-05-01",
  milestones: [
    {
      title: "R12 note",
      deliverable: "R12 evidence",
      acceptanceCriteria: "Reviewed",
      amountCents: 1000,
    },
  ],
};
test("R12 016 additive upgrade and actual acknowledgement query access paths", async () => {
  const temp = await mkdtemp(
    fileURLToPath(new URL("../../.data/r12-index-", import.meta.url)),
  );
  let f, store;
  const evidence = {
    startedAt: new Date().toISOString(),
    plans: [],
    cleanup: false,
  };
  const output = new URL(
    "../../.superpowers/sdd/interaction-round12-plan/final-fix-evidence/index-upgrade.json",
    import.meta.url,
  );
  try {
    // Freeze the real runner/fixture with only 001–015 present; do not remove an
    // installed migration or alter business rows to manufacture an upgrade case.
    await mkdir(path.join(temp, "migrations"));
    await writeFile(
      path.join(temp, "migrate.mjs"),
      await readFile(new URL("backend/db/migrate.mjs", root)),
    );
    const names = (await readdir(new URL("backend/db/migrations/", root)))
      .filter((n) => /^\d.*\.sql$/.test(n) && Number(n.slice(0, 3)) <= 15)
      .sort();
    assert.equal(names.length, 15);
    evidence.priorSources = [];
    for (const name of names) {
      const bytes = await readFile(
        new URL("backend/db/migrations/" + name, root),
      );
      await writeFile(path.join(temp, "migrations", name), bytes);
      evidence.priorSources.push({ name, checksum: sha(bytes) });
    }
    let fixtureSource = await readFile(
      new URL("./fixture.mjs", import.meta.url),
      "utf8",
    );
    fixtureSource = fixtureSource
      .replace(
        '"../../scripts/backend-local.mjs"',
        JSON.stringify(new URL("scripts/backend-local.mjs", root).href),
      )
      .replace(
        '"../../backend/db/migrate.mjs"',
        JSON.stringify(pathToFileURL(path.join(temp, "migrate.mjs")).href),
      );
    await writeFile(path.join(temp, "fixture.mjs"), fixtureSource);
    f = await (
      await import(pathToFileURL(path.join(temp, "fixture.mjs")).href)
    ).fixture();
    evidence.database = (
      await f.owner.query("SELECT current_database() AS name")
    ).rows[0].name;
    assert.notEqual(
      evidence.database,
      "campus_test_425fb12890d645e8a87c9fc441d3db24",
    );
    store = createStore(f.urls);
    let capture = false;
    const observed = {
      ...store,
      as: (actor, fn) =>
        store.as(actor, (c) =>
          fn({
            query: async (sql, params) => {
              const result = await c.query(sql, params);
              if (
                capture &&
                sql.startsWith(
                  "SELECT user_id,version,acknowledged_at FROM campus.application_terms_acknowledgements",
                )
              ) {
                const plan = (
                  await c.query(
                    "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql,
                    params,
                  )
                ).rows[0]["QUERY PLAN"];
                evidence.plans.push({ actor, sql, params, plan });
              }
              return result;
            },
          }),
        ),
    };
    const m = createMarket(observed),
      publisher = await f.user("R12 index publisher"),
      applicant = await f.user("R12 index applicant"),
      peer = await f.user("R12 index peer"),
      outsider = await f.user("R12 index outsider");
    await f.owner.query(
      "UPDATE campus.listing_lifecycle_cutover SET strict_versions=true",
    );
    const team = await m.createTeam(
      applicant,
      {
        name: "R12 index team",
        context: {
          purpose: "R12 query plans",
          activities: "Review terms",
          timeCommitment: "R12 bounded",
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
    await m.acceptMembership(
      peer,
      team.id,
      { expectedRevision: team.revision + 1 },
      key(),
    );
    const listing = await m.publishTask(publisher, task, key());
    const application = await m.applyVersioned(
      applicant,
      listing.id,
      {
        proposal: "R12 original proposal",
        teamId: team.id,
        expectedRevision: 1,
        expectedTermsVersion: 1,
      },
      key(),
    );
    const id = application.receipt.id;
    for (let v = 1; v <= 256; v++) {
      if (v > 1)
        await m.editTask(
          publisher,
          listing.id,
          {
            expectedRevision: v - 1,
            terms: { ...task, title: `R12 index version ${v}` },
          },
          key(),
        );
      const input = { expectedRevision: v, expectedTermsVersion: v };
      if (v > 1)
        await m.acknowledgeApplicationTerms(applicant, id, input, key());
      await m.acknowledgeApplicationTerms(peer, id, input, key());
    }
    evidence.compatibleBefore016 =
      (await m.applicationTerms(applicant, id)).acknowledgements.length === 2;
    const inventory = await oldInventory(f.owner);
    evidence.before = await preservation(f.owner, inventory);
    evidence.installedBefore = (
      await f.owner.query(
        "SELECT name,checksum FROM campus.schema_migrations ORDER BY name",
      )
    ).rows;
    assert.deepEqual(evidence.installedBefore, evidence.priorSources);
    evidence.applied = await migrate(f.owner);
    assert.equal(evidence.applied, 1);
    evidence.rerun = await migrate(f.owner);
    assert.equal(evidence.rerun, 0);
    evidence.after = await preservation(f.owner, inventory);
    assert.deepEqual(evidence.after, evidence.before);
    evidence.installedAfter = (
      await f.owner.query(
        "SELECT name,checksum FROM campus.schema_migrations ORDER BY name",
      )
    ).rows;
    const migration = await readFile(
      new URL(
        "backend/db/migrations/016_acknowledgement_version_index.sql",
        root,
      ),
    );
    evidence.migrationSha256 = sha(migration);
    assert.equal(
      evidence.installedAfter.at(-1).checksum,
      evidence.migrationSha256,
    );
    assert.deepEqual(
      evidence.installedAfter.slice(0, -1),
      evidence.installedBefore,
    );
    await f.owner.query("ANALYZE campus.application_terms_acknowledgements");
    capture = true;
    const first = await m.applicationTermsHistory(applicant, id, {
      kind: "acknowledgements",
      limit: 5,
    });
    const later = await m.applicationTermsHistory(applicant, id, {
      kind: "acknowledgements",
      limit: 5,
      ...first.next,
    });
    const current = await m.applicationTerms(peer, id);
    capture = false;
    assert.equal(first.items.length, 5);
    assert.equal(later.items.length, 5);
    assert.ok(later.next);
    assert.notDeepEqual(first.items, later.items);
    assert.equal(current.acknowledgements.length, 2);
    assert.deepEqual(current.missingAcknowledgements, []);
    assert.equal(current.application.proposal, "R12 original proposal");
    await assert.rejects(
      () =>
        m.applicationTermsHistory(outsider, id, { kind: "acknowledgements" }),
      (e) => e.code === "not_found",
    );
    const input = { expectedRevision: 256, expectedTermsVersion: 256 };
    await m.inviteApplicationVersion(publisher, id, input, key());
    assert.equal(
      (await m.applicationTerms(applicant, id)).reviewRequired,
      false,
    );
    const frozenParticipants = [
      ...new Set([
        current.application.applicant_id,
        ...current.members.map((member) => member.user_id),
      ]),
    ].sort();
    assert.deepEqual(
      current.members.map((member) => member.user_id).sort(),
      [applicant, peer].sort(),
    );
    assert.deepEqual(frozenParticipants, [applicant, peer].sort());
    evidence.pages = {
      first,
      later,
      currentAcknowledgements: current.acknowledgements,
      completeFrozenParticipants: frozenParticipants,
      expectedFrozenParticipants: [applicant, peer].sort(),
    };
    assert.equal(evidence.plans.length, 3);
    const flatten = (p) => [p, ...(p.Plans || []).flatMap(flatten)];
    for (const [i, item] of evidence.plans.entries()) {
      const nodes = flatten(item.plan[0].Plan);
      const index = nodes.find(
        (n) =>
          n["Index Name"] === "application_terms_acknowledgements_version_user",
      );
      assert.ok(index, `query ${i} did not choose the matching index`);
      assert.ok(index["Index Cond"].includes("application_id"));
      if (i === 1) assert.match(index["Index Cond"], /ROW\(version, user_id\)/);
      if (i === 2) assert.match(index["Index Cond"], /version = 256/);
      if (i < 2)
        assert.ok(
          !nodes.some((n) => n["Node Type"] === "Sort"),
          "history should stream index order",
        );
    }
    evidence.state = "passed";
  } catch (error) {
    evidence.state = "failed";
    evidence.error = String(error);
    throw error;
  } finally {
    if (store) await store.close();
    if (f) await f.close();
    await rm(temp, { recursive: true, force: true });
    evidence.cleanup = true;
    await writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
  }
});
