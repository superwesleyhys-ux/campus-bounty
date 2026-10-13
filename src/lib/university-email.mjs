// UI preflight only. The server independently checks the current active directory.
// Exact domains only: neither .edu suffixes nor unlisted subdomains are trusted.
/** @param {string} email @param {{name: string, domain: string}[]} directory */
export function universityForEmail(email, directory) {
  const parts = email.trim().toLowerCase().split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  return directory.find((school) => school.domain === parts[1]);
}
