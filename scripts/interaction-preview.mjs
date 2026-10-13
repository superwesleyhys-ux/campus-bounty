// Disposable, loopback-only browser fixture. Never connects to the cloud database.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { fixture } from "../tests/backend/fixture.mjs";
import { createStore } from "../backend/db/store.mjs";
import { createMarket } from "../backend/modules/market.mjs";
import { createMailWorker } from "../backend/adapters/mail-worker.mjs";
if (process.env.NODE_ENV === "production")
  throw new Error("Test fixture cannot run in production");
const f = await fixture(),
  store = createStore(f.urls),
  market = createMarket(store),
  users = {};
const folder = new URL("../.data/backend/interaction/", import.meta.url);
fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
for (const [name, eligible] of [
  ["Professor", false],
  ["Alex", true],
  ["Sam", true],
  ["Visitor", false],
  ["Reviewer", false],
  ["Riley", false],
  ["Morgan", false],
]) {
  const id = await f.user(name, eligible);
  users[name.toLowerCase()] = id;
  await f.owner.query(
    "INSERT INTO campus.identities VALUES($1,$2,'campus.example.test',now())",
    [`${name.toLowerCase()}@campus.example.test`, id],
  );
}
// Synthetic, institution-scoped reviewer for local eligibility UI checks only.
await f.owner.query(
  "INSERT INTO campus.eligibility_reviewers(user_id,institution_id) VALUES($1,$2)",
  [users.reviewer, f.institution],
);
const topics = [
  "Map campus tree biodiversity",
  "Build an accessible lab website",
  "Analyze a student transport survey",
  "Design a research poster",
  "Document the campus oral history",
  "Clean an ecology dataset",
  "Prototype a study-group planner",
  "Illustrate a physics teaching guide",
  "Audit library wayfinding",
  "Transcribe interview recordings",
  "Create a lab equipment inventory",
  "Review a Python analysis notebook",
  "Visualize energy use on campus",
  "Write a fieldwork guide",
];
const tasks = [];
for (let i = 0; i < topics.length; i++)
  tasks.push(
    await market.publishTask(
      users.professor,
      {
        title: topics[i],
        category: ["Research", "Engineering", "Research", "Design", "Writing"][
          i % 5
        ],
        description:
          "Work with a campus research group on a focused, well-defined project. Share your approach and relevant experience in your application. We value clear documentation and reproducible work.",
        rewardCents: 20000 + i * 2500,
        dueDate: new Date(Date.now() + (30 + i) * 86400000)
          .toISOString()
          .slice(0, 10),
        milestones: [
          {
            title: "Plan and initial results",
            deliverable: "A short plan and a reviewable first draft.",
            acceptanceCriteria:
              "Identify the data sources and methods. Include a sample result and list open questions for review.",
            amountCents: 10000,
          },
          {
            title: "Final delivery",
            deliverable:
              "Final work with source files, documentation and a short summary.",
            acceptanceCriteria:
              "Include all agreed source files and explain how to reproduce the results. Address the feedback from the first milestone.",
            amountCents: 10000 + i * 2500,
          },
        ],
      },
      randomUUID(),
    ),
  );
const products = [];
for (const [title, price] of [
  ["Introduction to Algorithms — fourth edition", 4500],
  ["Adjustable study lamp", 1800],
  ["Graphing calculator with case", 6500],
])
  products.push(
    await market.publishProduct(
      users.professor,
      {
        title,
        description:
          "Synthetic browser-test listing. Good working condition; see pickup and shipping options before reserving.",
        priceCents: price,
        stock: 4,
        deliveryMethods: ["pickup", "shipping"],
        shippingCents: 800,
      },
      randomUUID(),
    ),
  );
const team = await market.createTeam(
  users.alex,
  {
    name: "Campus Field Collective",
    context: {
      purpose: "Practice campus ecology fieldwork and prepare collaborative research proposals.",
      activities: "Meet on campus on Saturday mornings to compare observations and plan surveys.",
      timeCommitment: "About two hours each week during the semester; confirm each project separately.",
      projectContext: "Synthetic local preview group for a campus tree biodiversity survey.",
    },
  },
  randomUUID(),
);
await market.inviteMember(
  users.alex,
  team.id,
  { userId: users.sam, expectedRevision: team.revision },
  randomUUID(),
);
const application = await market.apply(
  users.alex,
  tasks[0].id,
  {
    proposal: "I will produce a reproducible dataset and a clear final report.",
  },
  randomUUID(),
);
await market.inviteApplicant(users.professor, application.id, {}, randomUUID());
const agreement = await market.acceptInvitation(
  users.alex,
  application.id,
  {},
  randomUUID(),
);
// Funding here is explicitly synthetic test setup, never a public API action.
await f.owner.query("UPDATE campus.agreements SET state='active' WHERE id=$1", [
  agreement.id,
]);
fs.writeFileSync(
  new URL("fixture.json", folder),
  JSON.stringify({
    database: new URL(f.urls.app).pathname.slice(1),
    users,
    tasks: tasks.map((t) => t.id),
    products: products.map((p) => p.id),
    team: team.id,
    agreement: agreement.id,
  }),
  { mode: 0o600 },
);
const worker = createMailWorker(store, {
  encryptionKey: f.config.encryptionKey,
  from: "local@campus.example.test",
  transport: {
    async sendMail(message) {
      if (!message.to.endsWith("@campus.example.test"))
        throw new Error("Synthetic recipients only");
      fs.writeFileSync(
        new URL(`${message.to.split("@")[0]}.txt`, folder),
        message.text,
        { mode: 0o600 },
      );
      return { accepted: [message.to], rejected: [] };
    },
  },
});
let ticking = false;
const timer = setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    await worker.tick();
    await market.expireReservations();
  } catch {
    console.error("Fixture worker tick failed");
  } finally {
    ticking = false;
  }
}, 500);
const next = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "dev",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3020",
  ],
  {
    env: {
      ...process.env,
      NODE_ENV: "development",
      CAMPUS_BACKEND: "postgres",
      CAMPUS_DEMO: "0",
      CAMPUS_BUILD_DIR: ".next-interaction",
      CAMPUS_ORIGIN: "http://127.0.0.1:3020",
      CAMPUS_DB_APP: f.urls.app,
      CAMPUS_DB_AUTH: f.urls.auth,
      CAMPUS_DB_WORKER: f.urls.worker,
      CAMPUS_OTP_KEY: f.config.otpKey,
      CAMPUS_MAIL_KEY: f.config.encryptionKey,
      CAMPUS_SMTP_HOST: "127.0.0.1",
      CAMPUS_SMTP_PORT: "1",
      CAMPUS_MAIL_FROM: "local@campus.example.test",
    },
    stdio: "inherit",
  },
);
console.log(
  "Disposable interaction preview: http://127.0.0.1:3020. Synthetic professor/alex/sam/visitor@campus.example.test. Codes stay under .data/backend/interaction. No external mail or payment.",
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  next.kill("SIGTERM");
  if (next.exitCode === null) await new Promise((r) => next.once("exit", r));
  await store.close();
  await f.close();
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
next.on("exit", () => void stop());
