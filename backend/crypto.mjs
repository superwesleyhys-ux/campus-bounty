import {
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export function secretKey(value) {
  if (!/^[a-f0-9]{64}$/i.test(value || ""))
    throw Error("A 32-byte hexadecimal key is required");
  return Buffer.from(value, "hex");
}
export const mac = (key, value) =>
  createHmac("sha256", secretKey(key)).update(value).digest("hex");
export function seal(key, data) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", secretKey(key), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(data), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), ciphertext]
    .map((b) => b.toString("base64url"))
    .join(".");
}
export function unseal(key, value) {
  const [iv, tag, data] = value
    .split(".")
    .map((v) => Buffer.from(v, "base64url"));
  const cipher = createDecipheriv("aes-256-gcm", secretKey(key), iv);
  cipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8"),
  );
}
