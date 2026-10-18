export class Problem extends Error {
  constructor(status, code, detail) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}
export function requireThat(condition, status, code, detail) {
  if (!condition) throw new Problem(status, code, detail);
}
export function parse(schema, input) {
  const r = schema.safeParse(input);
  if (!r.success)
    throw new Problem(422, "invalid_input", "Request fields are invalid.");
  return r.data;
}
export function found(row) {
  requireThat(row, 404, "not_found", "Resource not found.");
  return row;
}
