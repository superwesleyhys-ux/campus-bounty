import test from "node:test";
import assert from "node:assert/strict";
import { readInput } from "../src/lib/request-body.mjs";
test("oversized streamed bodies are cancelled before fully buffering", async () => {
  let bytes = 0,
    cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      bytes += 4096;
      controller.enqueue(new Uint8Array(4096));
      if (bytes >= 1048576) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    readInput({ headers: new Headers(), body }),
    (error) => error.status === 413,
  );
  assert.equal(cancelled, true);
  assert.ok(bytes < 25000);
});
test("input parsing preserves UTF-8 and rejects invalid JSON shapes", async () => {
  assert.deepEqual(
    await readInput(
      new Request("http://local", {
        method: "POST",
        body: JSON.stringify({ note: "Café · research" }),
      }),
    ),
    { note: "Café · research" },
  );
  for (const body of ["null", "[]", "oops"])
    await assert.rejects(
      readInput(new Request("http://local", { method: "POST", body })),
      (error) => error.status === 400,
    );
});
