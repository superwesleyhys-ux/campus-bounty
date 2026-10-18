import "server-only";
import { createRuntime, processSharedStore } from "../../backend/runtime.mjs";
import { readConfig } from "../../backend/config.mjs";
import { endpoint } from "../../backend/http/endpoint.mjs";
import { Problem } from "../../backend/errors.mjs";
let runtimePromise;
export async function runtime() {
  try {
    // Validate the configured destination even after this route has initialized.
    // A process must not quietly serve an old database after configuration drift.
    const store = processSharedStore(readConfig().urls);
    if (!runtimePromise)
      runtimePromise = createRuntime(process.env, { sharedStore: store }).catch(
        (error) => {
          runtimePromise = undefined;
          throw error;
        },
      );
    return await runtimePromise;
  } catch {
    throw new Problem(
      503,
      "backend_unavailable",
      "The shared backend is not configured or available.",
    );
  }
}
export function api(options, run) {
  return endpoint(runtime, options, run);
}
