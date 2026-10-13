import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, createHash, randomInt } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { seed } from "./seed.mjs";
import { migrateEnglishDemo } from "./migrations/english-demo.mjs";
import {
  DomainError,
  cents,
  nextTaskState,
  text,
  parseSchoolEmail,
} from "./domain.mjs";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const publicUser = ({ id, name, school, role, color }) => ({
  id,
  name,
  school,
  role,
  color,
});
export function createStore(
  file,
  {
    maxDocumentBytes = Infinity,
    maxSessions = Infinity,
    maxChallenges = Infinity,
  } = {},
) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout=5000");
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS document (id INTEGER PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY,email TEXT NOT NULL,school TEXT NOT NULL,hash TEXT NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL);",
  );
  db.prepare("INSERT OR IGNORE INTO document VALUES (1,?)").run(
    JSON.stringify(seed()),
  );
  const read = () =>
    JSON.parse(db.prepare("SELECT data FROM document WHERE id=1").get().data);
  function writeDocument(d) {
    const serialized = JSON.stringify(d);
    if (Buffer.byteLength(serialized) > maxDocumentBytes)
      throw new DomainError(
        "This demo workspace has reached its storage limit.",
        "DEMO_LIMIT",
        413,
      );
    db.prepare("UPDATE document SET data=? WHERE id=1").run(serialized);
  }
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const d = read();
      const result = fn(d);
      writeDocument(d);
      db.exec("COMMIT");
      return result;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  if (read().demoCopyLocale !== "en") transaction(migrateEnglishDemo);
  function state(userId) {
    const d = userId ? read() : seed();
    const user = d.users.find((u) => u.id === userId);
    const tasks = d.tasks.map((t) => ({
      ...t,
      applicationCount: t.applications.length,
      applications:
        t.ownerId === userId
          ? t.applications
          : t.applications.filter((a) => a.userId === userId),
      submissions: [t.ownerId, t.assigneeId].includes(userId)
        ? t.submissions
        : [],
      messages: [t.ownerId, t.assigneeId].includes(userId)
        ? t.messages.filter(
            (m) => t.ownerId === userId || m.participantIds?.includes(userId),
          )
        : [],
    }));
    return {
      demo: true,
      user: user
        ? { ...publicUser(user), email: user.email, saved: user.saved }
        : null,
      users: d.users.map(publicUser),
      tasks,
      products: d.products,
      orders: d.orders.filter(
        (o) => o.buyerId === userId || o.sellerId === userId,
      ),
    };
  }
  function command(userId, action, input = {}) {
    return transaction((d) => {
      const user = d.users.find((u) => u.id === userId);
      if (!user)
        throw new DomainError(
          "Sign in with your university email first.",
          "AUTH_REQUIRED",
          401,
        );
      let result = {};
      if (action === "publish") {
        const common = {
          id: randomUUID(),
          ownerId: userId,
          title: text(input.title, 5, 90),
          description: text(input.description, 10, 4000),
          category: text(input.category, 2, 30),
          tags:
            typeof input.tags === "string"
              ? input.tags
                  .split(/[,，]/)
                  .map((v) => v.trim())
                  .filter(Boolean)
                  .slice(0, 5)
                  .map((v) => text(v, 1, 30))
              : [],
          createdAt: Date.now(),
        };
        const amount = cents(input.amount);
        if (input.kind === "task") {
          const days = Number(input.durationDays);
          if (!Number.isInteger(days) || days < 1 || days > 30)
            throw new DomainError(
              "Delivery time must be between 1 and 30 days.",
            );
          const requirements = text(input.requirements, 5, 1500)
            .split("\n")
            .map((x) => x.trim())
            .filter(Boolean);
          d.tasks.unshift({
            ...common,
            reward: amount,
            durationDays: days,
            requirements,
            status: "open",
            assigneeId: null,
            applications: [],
            submissions: [],
            messages: [],
            paymentStatus: "demo_only",
          });
        } else if (input.kind === "product") {
          if (!["physical", "digital"].includes(input.productType))
            throw new DomainError("Choose a physical or digital item.");
          d.products.unshift({
            ...common,
            price: amount,
            productType: input.productType,
            delivery: text(input.delivery, 5, 300),
            art: input.productType === "digital" ? "code" : "parcel",
            status: "available",
          });
        } else throw new DomainError("Choose a bounty or an item.");
        result = { id: common.id };
      } else if (action === "save") {
        if (
          !d.tasks.some((t) => t.id === input.id) &&
          !d.products.some((p) => p.id === input.id)
        )
          throw new DomainError("Listing not found.", "NOT_FOUND", 404);
        user.saved = user.saved.includes(input.id)
          ? user.saved.filter((id) => id !== input.id)
          : [...user.saved, input.id];
      } else if (action === "buy") {
        const p = d.products.find((p) => p.id === input.id);
        if (!p) throw new DomainError("Item not found.", "NOT_FOUND", 404);
        if (p.ownerId === userId)
          throw new DomainError("You cannot buy your own item.");
        if (p.status !== "available")
          throw new DomainError(
            "This item is already reserved or sold.",
            "STATE_CONFLICT",
            409,
          );
        const order = {
          id: randomUUID(),
          productId: p.id,
          title: p.title,
          price: p.price,
          buyerId: userId,
          sellerId: p.ownerId,
          status: "reserved",
          paymentStatus: "demo_only",
          createdAt: Date.now(),
          note: "",
        };
        d.orders.unshift(order);
        p.status = "reserved";
        result = { id: order.id };
      } else if (["fulfill", "received"].includes(action)) {
        const order = d.orders.find((o) => o.id === input.id);
        if (!order) throw new DomainError("Order not found.", "NOT_FOUND", 404);
        if (
          action === "fulfill" &&
          order.sellerId === userId &&
          order.status === "reserved"
        ) {
          order.note = text(input.note, 5, 2000);
          order.status = "delivered";
        } else if (
          action === "received" &&
          order.buyerId === userId &&
          order.status === "delivered"
        ) {
          order.status = "completed";
          d.products.find((p) => p.id === order.productId).status = "sold";
        } else
          throw new DomainError(
            "Your role or the current order status does not allow this action.",
            "STATE_CONFLICT",
            409,
          );
      } else {
        const t = d.tasks.find((t) => t.id === input.id);
        if (!t) throw new DomainError("Bounty not found.", "NOT_FOUND", 404);
        const role =
          t.ownerId === userId
            ? "owner"
            : t.assigneeId === userId
              ? "assignee"
              : "applicant";
        if (action === "apply") {
          if (t.ownerId === userId)
            throw new DomainError("You cannot apply for your own bounty.");
          if (t.status !== "open")
            throw new DomainError(
              "This task is no longer accepting applications.",
              "STATE_CONFLICT",
              409,
            );
          if (!t.applications.some((a) => a.userId === userId))
            t.applications.push({
              userId,
              note: text(input.note, 5, 1500),
              createdAt: Date.now(),
            });
        } else if (action === "message") {
          if (!["owner", "assignee"].includes(role))
            throw new DomainError(
              "Only the task participants can send messages.",
              "FORBIDDEN",
              403,
            );
          t.messages.push({
            id: randomUUID(),
            userId,
            participantIds: [t.ownerId, t.assigneeId].filter(Boolean),
            body: text(input.note, 1, 2000),
            createdAt: Date.now(),
          });
        } else {
          const next = nextTaskState(t.status, action, role);
          if (action === "select") {
            if (!t.applications.some((a) => a.userId === input.applicantId))
              throw new DomainError("Choose someone who has applied.");
            t.assigneeId = input.applicantId;
          }
          if (action === "decline") t.assigneeId = null;
          if (action === "accept") t.startedAt = Date.now();
          if (action === "submit") {
            let url = "";
            if (input.url) {
              try {
                const u = new URL(input.url);
                if (u.protocol !== "https:") throw new Error();
                url = u.href;
              } catch {
                throw new DomainError(
                  "Deliverable links must start with https://",
                );
              }
            }
            t.submissions.push({
              id: randomUUID(),
              note: text(input.note, 5, 4000),
              url,
              userId,
              createdAt: Date.now(),
            });
          }
          if (action === "revise")
            t.messages.push({
              id: randomUUID(),
              userId,
              participantIds: [t.ownerId, t.assigneeId].filter(Boolean),
              body: "Revision feedback: " + text(input.note, 5, 2000),
              createdAt: Date.now(),
            });
          t.status = next;
        }
      }
      d.audit.push({
        id: randomUUID(),
        actor: userId,
        action,
        objectId: result.id || input.id,
        time: Date.now(),
      });
      return result;
    });
  }
  function session(userId) {
    db.prepare("DELETE FROM sessions WHERE expires<=?").run(Date.now());
    if (db.prepare("SELECT count(*) AS n FROM sessions").get().n >= maxSessions)
      throw new DomainError(
        "Too many active demo sessions. Please try later.",
        "DEMO_LIMIT",
        429,
      );
    const token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
      digest(token),
      userId,
      Date.now() + 12 * 3600000,
    );
    return token;
  }
  function sessionUser(token) {
    if (!token) return null;
    const s = db
      .prepare("SELECT user_id FROM sessions WHERE token=? AND expires>?")
      .get(digest(token), Date.now());
    return s?.user_id || null;
  }
  function quickSession(id) {
    if (!["student", "professor", "maker"].includes(id))
      throw new DomainError("Invalid demo account.");
    return session(id);
  }
  function requestCode(value) {
    const { email, school } = parseSchoolEmail(value);
    const now = Date.now();
    db.prepare("DELETE FROM challenges WHERE created<?").run(now - 3600000);
    if (
      db.prepare("SELECT count(*) AS n FROM challenges").get().n >=
      maxChallenges
    )
      throw new DomainError(
        "Too many code requests. Please try later.",
        "DEMO_LIMIT",
        429,
      );
    const recent = db
      .prepare(
        "SELECT count(*) AS n FROM challenges WHERE email=? AND created>?",
      )
      .get(email, now - 3600000);
    if (recent.n >= 5)
      throw new DomainError(
        "Too many code requests. Please try again later.",
        "RATE_LIMIT",
        429,
      );
    const id = randomUUID(),
      code = String(randomInt(100000, 1000000));
    db.prepare(
      "INSERT INTO challenges(id,email,school,hash,expires,created) VALUES(?,?,?,?,?,?)",
    ).run(id, email, school, digest(id + code), now + 5 * 60000, now);
    return { challengeId: id, demoCode: code };
  }
  function verifyCode(id, code) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const c = db.prepare("SELECT * FROM challenges WHERE id=?").get(id);
      if (!c || c.expires < Date.now() || c.attempts >= 5) {
        db.exec("COMMIT");
        throw new DomainError("This code is invalid or has expired.");
      }
      db.prepare("UPDATE challenges SET attempts=attempts+1 WHERE id=?").run(
        id,
      );
      if (digest(id + String(code)) !== c.hash) {
        db.exec("COMMIT");
        throw new DomainError("Incorrect verification code.");
      }
      const d = read();
      let u = d.users.find((u) => u.email === c.email);
      if (!u) {
        u = {
          id: randomUUID(),
          name: c.email.split("@")[0].slice(0, 20),
          email: c.email,
          school: c.school,
          role: "Member",
          color: "blue",
          saved: [],
        };
        d.users.push(u);
        writeDocument(d);
      }
      // Retain the request timestamp for rate limiting, invalidate the secret.
      db.prepare("UPDATE challenges SET expires=0,hash='' WHERE id=?").run(id);
      const token = session(u.id);
      db.exec("COMMIT");
      return token;
    } catch (e) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw e;
    }
  }
  function logout(token) {
    if (token)
      db.prepare("DELETE FROM sessions WHERE token=?").run(digest(token));
  }
  return {
    close: () => db.close(),
    state,
    command,
    sessionUser,
    quickSession,
    requestCode,
    verifyCode,
    logout,
  };
}
