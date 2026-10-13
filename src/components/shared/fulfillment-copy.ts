import type { FulfillmentResult } from "./fulfillment-types";
export function fulfillmentNotice(
  result: FulfillmentResult,
  sent: Record<string, unknown>,
  recovered: boolean,
) {
  const operation = result.receipt.operation;
  const version =
    Number(sent.expectedVersion) + (operation === "submit" ? 1 : 0);
  const action =
    operation === "submit"
      ? "submission"
      : operation === "revision_requested"
        ? "change request"
        : "acceptance";
  const message = recovered
    ? `Your earlier ${action} was confirmed. The latest status is shown below.`
    : operation === "submit"
      ? `Version ${version} submitted for review.`
      : operation === "revision_requested"
        ? `Changes requested for version ${version}.`
        : `Version ${version} accepted.`;
  const completed =
    result.agreement.state === "completed"
      ? " The agreement is completed."
      : "";
  const funds = operation === "accepted" ? " No funds were transferred." : "";
  return message + completed + funds;
}
