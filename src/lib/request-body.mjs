import { DomainError } from "./domain.mjs";

export async function readInput(request, limit = 16000) {
  const tooLarge = () =>
    new DomainError("Content is too long.", "CONTENT_TOO_LARGE", 413);
  if (Number(request.headers.get("content-length")) > limit) throw tooLarge();
  const reader = request.body?.getReader();
  const chunks = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw tooLarge();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new DomainError("Invalid request format.", "INVALID_INPUT", 400);
  }
}
