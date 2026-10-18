// Real React components/hooks, intercepted transport contract fixtures. No database or provider outcomes.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "/Users/huangyusen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
const require = createRequire(import.meta.url),
  { webpack } = require("next/dist/compiled/webpack/webpack"),
  root = process.cwd(),
  e = path.resolve(
    ".superpowers/sdd/interaction-round13-plan/task-3-fix1-evidence",
  ),
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "r13-fix1-components-"));
fs.writeFileSync(
  path.join(temp, "loader.cjs"),
  `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=function(s){return ts.transpile(s,{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX})};`,
);
await new Promise((resolve, reject) =>
  webpack(
    {
      mode: "production",
      entry: path.join(root, "tests/fixtures/r13-fix1/components.tsx"),
      output: { path: temp, filename: "bundle.js" },
      resolve: {
        alias: { "@": path.join(root, "src") },
        extensions: [".tsx", ".ts", ".js"],
        modules: [path.join(root, "node_modules")],
      },
      module: {
        rules: [{ test: /\.tsx?$/, use: path.join(temp, "loader.cjs") }],
      },
      optimization: { minimize: false },
    },
    (err, stats) =>
      err || stats.hasErrors()
        ? reject(err || Error(stats.toString({ all: false, errors: true })))
        : resolve(),
  ),
);
const browser = await chromium.launch({ headless: true }),
  checks = [];
try {
  const p = await browser.newPage();
  await p.route("**/*", (r) =>
    r.request().isNavigationRequest()
      ? r.fulfill({
          contentType: "text/html",
          body: '<html lang="en"><title>R13 component contract fixture</title><div id="root"></div></html>',
        })
      : r.abort(),
  );
  await p.goto("http://127.0.0.1:3029");
  await p.addScriptTag({
    content: fs.readFileSync(path.join(temp, "bundle.js"), "utf8"),
  });
  await p.addStyleTag({
    content: fs.readFileSync("src/components/shared/shared.css", "utf8"),
  });
  const phase = process.argv[2] || "all";
  for (const operation of phase === "all"
    ? ["propose", "submit", "accepted", "revision_requested"]
    : []) {
    await p.evaluate((operation) => {
      const { id, account, agreement, base } = window.fixture;
      sessionStorage.clear();
      window.calls = [];
      window.mode = "history429";
      window.meMode = "ok";
      window.commits = new Set();
      const isAm = operation === "propose";
      const body = isAm
        ? {
            expectedEffectiveTermsId: base.id,
            expectedEffectiveRevision: 1,
            reason: "Fixture proposal",
            terms: {
              ...base.terms,
              dueDate: "2027-04-01",
              milestones: base.milestones,
              retireMilestoneIds: [],
            },
          }
        : operation === "submit"
          ? {
              content: "Fixture exact content",
              expectedVersion: 0,
              expectedRevision: 0,
              expectedEffectiveTermsId: base.id,
              expectedEffectiveRevision: 1,
            }
          : {
              submissionId: id(5),
              expectedVersion: 1,
              expectedRevision: 1,
              submissionTermsId: base.id,
              submissionTermsRevision: 1,
              ...(operation === "revision_requested"
                ? { feedback: "Fixture exact feedback" }
                : {}),
            };
      window.testBody = body;
      window.fetch = async (url, init = {}) => {
        const json = (value, status = 200) =>
          new Response(JSON.stringify(value), {
            status,
            headers: { "Content-Type": "application/json" },
          });
        if (url.endsWith("/me"))
          return window.meMode === "429"
            ? json({ detail: "identity429" }, 429)
            : json({ id: window.meMode === "other" ? id(9) : account.id });
        if (init.method === "POST") {
          window.calls.push({
            path: url,
            body: init.body,
            key: init.headers["Idempotency-Key"],
          });
          window.commits.add(init.headers["Idempotency-Key"]);
          return json(
            isAm
              ? {
                  agreement: { id: agreement.id, state: "active" },
                  effectiveTerms: base,
                  amendment: {
                    id: id(6),
                    status: "pending",
                    proposalRevision: 1,
                  },
                  receipt: {
                    operation: "propose",
                    agreementId: agreement.id,
                    amendmentId: id(6),
                    eventId: id(7),
                    termsId: id(10),
                    termsRevision: 2,
                    proposalRevision: 1,
                    outcomeAtCommit: "pending",
                  },
                }
              : {
                  agreement: { id: agreement.id },
                  milestone: { id: id(3), revision: 2 },
                  receipt: { operation, submissionId: id(5), reviewId: id(7) },
                },
          );
        }
        if (window.mode === "history429")
          return json({ detail: "history429" }, 429);
        if (window.mode === "malformed") return json({ wrong: "shape" });
        if (isAm)
          return json({
            agreementId: agreement.id,
            reason: body.reason,
            baseTerms: base,
            proposedTerms: {
              ...base,
              id: id(10),
              revision: 2,
              terms: body.terms,
            },
            retiredMilestoneIds: [],
          });
        if (url.endsWith("/reviews"))
          return json([
            {
              id: id(7),
              decision: operation,
              submission_id: id(5),
              submission_version: 1,
              feedback: body.feedback,
            },
          ]);
        return json([
          {
            id: id(5),
            version: 1,
            content: "Fixture exact content",
            submissionTermsId: base.id,
            submissionTermsRevision: 1,
          },
        ]);
      };
      window.mount("hook", {
        kind: isAm ? "amendment" : "work",
        operation,
        body,
        path: `milestones/${id(3)}/${operation === "submit" ? "submissions" : operation === "accepted" ? "acceptance" : "revision-requests"}`,
      });
    }, operation);
    const send = p.getByRole("button", { name: "Send or recover" });
    await p.waitForFunction(() => window.probe?.phase === "idle");
    await send.click();
    await p.waitForFunction(() => window.probe.phase === "unknown");
    assert.equal(await p.evaluate(() => window.commits.size), 1);
    await p.evaluate(() => (window.meMode = "429"));
    await send.click();
    await p.waitForFunction(() => window.probe.error === "identity429");
    assert.equal(await p.evaluate(() => window.calls.length), 1);
    await p.evaluate(() => (window.meMode = "other"));
    await send.click();
    await p.waitForFunction(() =>
      window.probe.error?.includes("account changed"),
    );
    assert.equal(await p.evaluate(() => window.calls.length), 1);
    assert.equal(await p.evaluate(() => window.probe.phase), "unknown");
    await p.evaluate(() => {
      window.meMode = "ok";
      window.mode = "malformed";
    });
    await send.click();
    await p.waitForFunction(
      () => window.calls.length === 2 && window.probe.phase === "unknown",
    );
    await p.evaluate(() => (window.mode = "ok"));
    await send.click();
    await p.waitForFunction(() => window.probe.success === 1);
    const calls = await p.evaluate(() => window.calls);
    assert.equal(calls.length, 3);
    for (const c of calls) assert.deepEqual(c, calls[0]);
    assert.equal(await p.evaluate(() => window.commits.size), 1);
    assert.equal(
      await p.evaluate(
        () =>
          Object.keys(sessionStorage).filter((k) => k.includes("-request:"))
            .length,
      ),
      0,
    );
    checks.push({
      operation,
      realHook: true,
      transport: "mock contract fixture",
      history429Retained: true,
      identity429NoPost: true,
      otherActorNoPost: true,
      malformedRetained: true,
      samePathBodyKey: true,
      verifiedSuccess: 1,
      mockImmutableOutcomes: 1,
    });
  }
  for (const older of ["all", "drafts"].includes(phase) ? [false, true] : []) {
    await p.reload();
    await p.addScriptTag({
      content: fs.readFileSync(path.join(temp, "bundle.js"), "utf8"),
    });
    await p.evaluate((older) => {
      const { account, agreement, draft } = window.fixture;
      sessionStorage.clear();
      if (older)
        sessionStorage.setItem(
          `campus:amendment-draft:${account.id}:${agreement.id}:create`,
          JSON.stringify({ ...draft, reason: "Older saved reason" }),
        );
      Storage.prototype.setItem = function () {
        throw new DOMException("Synthetic denied", "SecurityError");
      };
      window.mount("editor");
    }, older);
    await p.getByLabel("Reason for this change").fill("Latest retained reason");
    await p.getByLabel("General scope").fill("Latest retained scope");
    await p.getByLabel("Proposed target date").fill("2027-05-02");
    await p
      .getByRole("button", { name: "Close draft (keep edits)", exact: true })
      .click();
    await p.getByRole("button", { name: "Open draft", exact: true }).click();
    assert.equal(
      await p.getByLabel("Reason for this change").inputValue(),
      "Latest retained reason",
    );
    assert.equal(
      await p.getByLabel("General scope").inputValue(),
      "Latest retained scope",
    );
    assert.equal(
      await p.getByLabel("Proposed target date").inputValue(),
      "2027-05-02",
    );
    await p
      .getByRole("button", { name: "Review comparison", exact: true })
      .click();
    await p.getByRole("dialog").waitFor();
    await p.keyboard.press("Escape");
    await p.getByRole("button", { name: "Switch actor", exact: true }).click();
    await p.getByRole("button", { name: "Open draft", exact: true }).click();
    assert.equal(await p.getByLabel("Reason for this change").inputValue(), "");
    await p.getByRole("button", { name: "Switch actor", exact: true }).click();
    await p.getByRole("button", { name: "Open draft", exact: true }).click();
    assert.equal(
      await p.getByLabel("Reason for this change").inputValue(),
      "Latest retained reason",
    );
    await p
      .getByRole("button", { name: "Review comparison", exact: true })
      .click();
    await p
      .getByRole("button", { name: "Publish proposal", exact: true })
      .click();
    const published = await p.evaluate(() => window.lastPublished);
    assert.equal(
      published.expectedEffectiveTermsId,
      await p.evaluate(() => window.fixture.base.id),
    );
    assert.equal(published.expectedEffectiveRevision, 1);
    assert.equal(published.reason, "Latest retained reason");
    assert.equal(published.terms.description, "Latest retained scope");
    assert.equal(published.terms.dueDate, "2027-05-02");
    await p.getByRole("button", { name: "Open draft", exact: true }).click();
    assert.equal(await p.getByLabel("Reason for this change").inputValue(), "");
    checks.push({
      check: "actual close-keep/reopen",
      olderSavedDraft: older,
      reasonAndFieldsRetained: true,
      actorIsolation: true,
      verifiedCallbackClears: true,
      keyboardEscape: true,
    });
  }
  if (["all", "retired"].includes(phase)) {
    for (const pending of [false, true]) {
      await p.reload();
      await p.addScriptTag({
        content: fs.readFileSync(path.join(temp, "bundle.js"), "utf8"),
      });
      await p.addStyleTag({
        content: fs.readFileSync("src/components/shared/shared.css", "utf8"),
      });
      await p.evaluate((pending) => {
        window.fetch = async (url) => {
          const { account, id, base, retiredAgreement: g } = window.fixture;
          let value = url.endsWith("/me")
            ? account
            : url.includes("/agreements/")
              ? g
              : url.endsWith("/reviews")
                ? []
                : url.includes(id(8)) || pending
                  ? []
                  : [
                      {
                        id: id(5),
                        version: 1,
                        content: "Retained accepted historical deliverable",
                        created_at: "2026-10-17T12:00:00Z",
                        submissionTerms: base,
                        submissionTermsRevision: 1,
                        milestoneTerms: base.milestones[0],
                      },
                    ];
          return new Response(JSON.stringify(value), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        };
        window.mount("retired", { pending });
      }, pending);
      await p
        .getByText("Retired stage · read-only history.", { exact: false })
        .waitFor();
      await p
        .getByText("No work submitted yet.", { exact: true })
        .last()
        .waitFor();
      assert.equal(
        await p
          .getByRole("button", { name: "Finish agreement", exact: true })
          .count(),
        pending ? 0 : 1,
      );
      await p
        .getByText(`${pending ? 0 : 1} of 1 included milestones accepted`, {
          exact: false,
        })
        .waitFor();
      const retired = p.locator("article").filter({
        has: p.getByRole("heading", {
          name: "2. Retired historical stage",
          exact: true,
        }),
      });
      assert.equal(await retired.locator("form").count(), 0);
      assert.ok((await retired.innerText()).includes("Original criteria"));
      if (!pending) {
        await p
          .getByText("Retained accepted historical deliverable", {
            exact: true,
          })
          .waitFor();
        await p.getByText("Submitted under terms 1", { exact: true }).waitFor();
      }
      await p.screenshot({
        path: path.join(
          e,
          `included-retired-${pending ? "pending" : "accepted"}.png`,
        ),
        fullPage: true,
      });
      checks.push({
        check: "actual summary/completion/milestone contract fixture",
        includedPending: pending,
        includedCount: 1,
        retiredExcluded: true,
        completionVisible: !pending,
        retiredReadOnlyAndReachable: true,
        includedHistoricalSubmissionReachable: !pending,
        actualFundedMaterialization: false,
      });
    }
  }
  fs.writeFileSync(
    path.join(e, `component-${phase}-results.json`),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        scope:
          "Actual source components/hooks with mocked transport only; no real DB/provider outcome",
        checks,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(checks));
} finally {
  await browser.close();
  fs.rmSync(temp, { recursive: true });
}
