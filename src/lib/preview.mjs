import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { createStore } from "./store.mjs";
import { DomainError, parseSchoolEmail } from "./domain.mjs";

export function validateAuthStart(data) {
  if (data.action === "request") parseSchoolEmail(data.email);
  if (
    data.action === "quick" &&
    !["student", "professor", "maker"].includes(data.id)
  )
    throw new DomainError("Invalid demo account.");
}

export function checkRequest(
  headers,
  { enabled, publicOrigin },
  write = false,
) {
  const host = headers.get("host") || "";
  if (enabled !== "1")
    throw new DomainError("Demo access is disabled.", "FORBIDDEN", 403);
  let expected;
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (
      url.protocol !== "https:" ||
      url.origin !== publicOrigin ||
      host !== url.host
    )
      throw new DomainError("Invalid preview host.", "FORBIDDEN", 403);
    expected = publicOrigin;
  } else {
    if (!/^127\.0\.0\.1:\d+$/.test(host))
      throw new DomainError(
        "This demo is available only on this computer.",
        "FORBIDDEN",
        403,
      );
    expected = `http://${host}`;
  }
  if (write && headers.get("origin") !== expected)
    throw new DomainError("Invalid request origin.", "FORBIDDEN", 403);
}

export function createPreviewPool(
  directory,
  { maxWorkspaces = 128, maxOpen = 8, maxIdleMs = 7 * 86400000 } = {},
) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stores = new Map();
  const valid = (id) => typeof id === "string" && /^[a-f0-9]{48}$/.test(id);
  const file = (id) => join(directory, `${id}.db`);
  function expire(id) {
    if (
      !existsSync(file(id)) ||
      Date.now() - statSync(file(id)).mtimeMs <= maxIdleMs
    )
      return false;
    stores.get(id)?.close();
    stores.delete(id);
    for (const suffix of ["", "-wal", "-shm"])
      rmSync(file(id) + suffix, { force: true });
    return true;
  }
  function get(id) {
    if (!valid(id) || !existsSync(file(id))) return null;
    if (expire(id)) return null;
    const now = new Date();
    utimesSync(file(id), now, now);
    if (stores.has(id)) {
      const store = stores.get(id);
      stores.delete(id);
      stores.set(id, store);
      return store;
    }
    if (stores.size >= maxOpen) {
      const oldest = stores.keys().next().value;
      stores.get(oldest).close();
      stores.delete(oldest);
    }
    const store = createStore(file(id), {
      maxDocumentBytes: 1_048_576,
      maxSessions: 64,
      maxChallenges: 128,
    });
    stores.set(id, store);
    return store;
  }
  function create() {
    for (const name of readdirSync(directory)) {
      if (/^[a-f0-9]{48}\.db$/.test(name)) expire(name.slice(0, -3));
    }
    const count = readdirSync(directory).filter((name) =>
      /^[a-f0-9]{48}\.db$/.test(name),
    ).length;
    if (count >= maxWorkspaces)
      throw new DomainError(
        "The preview is at capacity. Please try again later.",
        "DEMO_CAPACITY",
        503,
      );
    const id = randomBytes(24).toString("hex");
    // Create only on an explicit sign-in request, never for crawlers or page views.
    const initial = createStore(file(id), { maxDocumentBytes: 1_048_576 });
    initial.close();
    return { id, store: get(id) };
  }
  return {
    get,
    create,
    close() {
      for (const store of stores.values()) store.close();
      stores.clear();
    },
  };
}
