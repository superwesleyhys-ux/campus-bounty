// A delivery target is a calendar date, not a local-midnight timestamp.
export function isCalendarDate(value) {
  if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

export function formatDueDate(value) {
  if (!isCalendarDate(value)) return "Not specified";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00.000Z`));
}

export function validateTaskTerms(dueDate, milestones) {
  if (!isCalendarDate(dueDate))
    throw new Error("Choose a valid target delivery date.");
  for (const [index, milestone] of milestones.entries()) {
    const criteria = milestone.acceptanceCriteria;
    if (typeof criteria !== "string" || !criteria.trim())
      throw new Error(`Add acceptance criteria for milestone ${index + 1}.`);
    if (criteria.trim().length > 10000)
      throw new Error(
        `Keep milestone ${index + 1} acceptance criteria within 10,000 characters.`,
      );
  }
}
