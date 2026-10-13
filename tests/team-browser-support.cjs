// Helpers for real browser checks on the existing disposable loopback preview.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { randomUUID, randomInt } = require("node:crypto");
const path = require("node:path");
const pg = require("pg");
const origin = "http://127.0.0.1:3020";
const button = (page, name) => page.getByRole("button", { name, exact: true });

async function withFixture(fn) {
  const { localConfig, connectionString } =
    await import("../scripts/backend-local.mjs");
  const fixture = JSON.parse(
    fs.readFileSync(".data/backend/interaction/fixture.json"),
  );
  assert.match(fixture.database, /^campus_test_[a-f0-9]{32}$/);
  const url = connectionString(localConfig(), "migrator", fixture.database);
  assert.equal(new URL(url).hostname, "127.0.0.1");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function seedPeople(names) {
  return withFixture(async (client) => {
    const suffix = randomUUID().slice(0, 8);
    const people = names.map((name, index) => ({
      id: randomUUID(),
      name,
      emailName: `team-${suffix}-${index}`,
    }));
    await client.query("BEGIN");
    try {
      const { institution_id } = (
        await client.query(
          "SELECT institution_id FROM campus.domains WHERE domain='campus.example.test' AND enabled",
        )
      ).rows[0];
      for (const person of people) {
        await client.query(
          "INSERT INTO campus.users(id,display_name) VALUES($1,$2)",
          [person.id, person.name],
        );
        await client.query(
          "INSERT INTO campus.affiliations(user_id,institution_id,domain,valid_until,can_apply,student_valid_until) VALUES($1,$2,'campus.example.test',now()+interval '180 days',true,now()+interval '90 days')",
          [person.id, institution_id],
        );
        await client.query(
          "INSERT INTO campus.identities(email,user_id,domain,verified_at) VALUES($1,$2,'campus.example.test',now())",
          [`${person.emailName}@campus.example.test`, person.id],
        );
      }
      await client.query("COMMIT");
      return people;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

async function login(page, person) {
  if (process.env.CAMPUS_CONTEXT_FIXTURE_AUTH === "1")
    return fixtureSessionLogin(page, person);
  await page.goto(origin);
  await page
    .getByLabel("University email", { exact: true })
    .fill(`${person.emailName}@campus.example.test`);
  const started = Date.now();
  await button(page, "Email me a sign-in code").click();
  await page.getByLabel("Sign-in code", { exact: true }).waitFor();
  const mail = `.data/backend/interaction/${person.emailName}.txt`;
  let code;
  for (let i = 0; i < 150; i++) {
    if (fs.existsSync(mail) && fs.statSync(mail).mtimeMs >= started)
      code = fs
        .readFileSync(mail, "utf8")
        .match(/verification code is (\d{6})/)?.[1];
    if (code) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(code, "Local synthetic code received");
  await page.getByLabel("Sign-in code", { exact: true }).fill(code);
  await page.getByLabel("Your display name", { exact: true }).fill(person.name);
  await button(page, "Verify and continue").click();
  await button(page, "Sign out").waitFor();
}

// Explicit opt-in for context UI tests, excluding OTP delivery from their scope.
// Uses the real auth verifier and role, never changes or disables rate limits.
async function fixtureSessionLogin(page, person) {
  assert.equal(process.env.CAMPUS_CONTEXT_FIXTURE_AUTH, "1");
  assert.match(person.emailName, /^team-[a-f0-9]{8}-\d+$/);
  const folder = path.resolve(".data/qa/context-browser");
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const stateFile = path.join(folder, `${person.id}.state.json`);
  if (fs.existsSync(stateFile)) {
    await page
      .context()
      .addCookies(JSON.parse(fs.readFileSync(stateFile, "utf8")).cookies);
    await page.goto(origin);
    const current = await page.evaluate(async () => {
      const response = await fetch("/api/v1/me");
      return response.ok ? response.json() : null;
    });
    if (current?.id === person.id) return;
  }
  const { localConfig } = await import("../scripts/backend-local.mjs");
  const { mac } = await import("../backend/crypto.mjs");
  const { createAuth } = await import("../backend/modules/auth.mjs");
  const config = localConfig();
  const session = await withFixture(async (client) => {
    const identity = await client.query(
      "SELECT 1 FROM campus.identities WHERE user_id=$1 AND email=$2 AND domain='campus.example.test'",
      [person.id, `${person.emailName}@campus.example.test`],
    );
    assert.equal(
      identity.rowCount,
      1,
      "Only the known synthetic identity can receive a fixture session",
    );
    const challengeId = randomUUID(),
      code = String(randomInt(100000, 1000000));
    await client.query(
      "INSERT INTO campus.challenges(id,email,code_hash,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",
      [
        challengeId,
        `${person.emailName}@campus.example.test`,
        mac(config.otpKey, `${challengeId}:${code}`),
      ],
    );
    const auth = createAuth(
      {
        authTx: async (callback) => {
          await client.query("BEGIN");
          try {
            await client.query("SET LOCAL ROLE campus_auth");
            const value = await callback(client);
            await client.query("COMMIT");
            return value;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        },
      },
      config,
    );
    return auth.verify(
      { challengeId, code, displayName: person.name },
      `context-fixture:${person.id}`,
    );
  });
  await page.context().addCookies([
    {
      name: "campus_session",
      value: session.token,
      url: origin,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  await page.goto(origin);
  await button(page, "Sign out").waitFor();
  const current = await page.evaluate(async () =>
    (await fetch("/api/v1/me")).json(),
  );
  assert.equal(current.id, person.id);
  await page.context().storageState({ path: stateFile });
  fs.chmodSync(stateFile, 0o600);
}

const defaultTeamContext = {
  purpose: "Develop a reproducible campus research project.",
  activities: "Review evidence together and meet online each Wednesday.",
  timeCommitment: "About 2 hours each week for four weeks.",
  projectContext:
    "Synthetic local test project; no live commitments or payment.",
};
async function fillTeamBackground(scope, values = defaultTeamContext) {
  await scope.getByLabel("Team purpose", { exact: true }).fill(values.purpose);
  await scope
    .getByLabel("Activities and schedule", { exact: true })
    .fill(values.activities);
  await scope
    .getByLabel("Expected time commitment", { exact: true })
    .fill(values.timeCommitment);
  await scope
    .getByLabel("Project background (optional)", { exact: true })
    .fill(values.projectContext || "");
}
module.exports = {
  origin,
  button,
  withFixture,
  seedPeople,
  login,
  defaultTeamContext,
  fillTeamBackground,
  fixtureSessionLogin,
};
