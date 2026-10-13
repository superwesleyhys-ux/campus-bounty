"use client";
import { useCallback, useState } from "react";
import { useResource } from "./api";
import { type Account } from "./types";
import { Empty, ResourceState } from "./ui";
import { TeamCard } from "./team-card";
import { TeamCreate } from "./team-create";
import type { TeamSummary } from "./team-types";

export function Teams({ account }: { account: Account }) {
  // Former members can still review their history after eligibility expires.
  const resource = useResource<TeamSummary[]>("teams");
  const [copied, setCopied] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const refresh = useCallback(() => {
    resource.reload();
    setRefreshVersion((value) => value + 1);
  }, [resource.reload]);
  return (
    <>
      <div className="cb-heading">
        <div>
          <span className="cb-eyebrow">Better together</span>
          <h1>Your teams</h1>
          <p>
            Build a team first. Every member agrees separately to each bounty
            proposal.
          </p>
        </div>
        <button
          className="cb-button"
          disabled={resource.loading}
          onClick={refresh}
        >
          {resource.loading ? "Refreshing…" : "Refresh teams"}
        </button>
      </div>
      <div className="cb-detail-grid">
        <section aria-label="Your team memberships">
          <ResourceState {...resource} />
          {resource.data?.length === 0 && (
            <Empty title="Your first team starts here">
              Create a team or ask a captain to invite you using your member
              code.
            </Empty>
          )}
          {resource.data?.map((team) => (
            <div key={team.id} id={`team-${team.id}`} tabIndex={-1}>
              <TeamCard
                summary={team}
                account={account}
                refreshVersion={refreshVersion}
                listLoading={resource.loading}
                onChanged={refresh}
              />
            </div>
          ))}
        </section>
        <aside>
          <div className="cb-panel">
            <h2>Your member code</h2>
            <p>Share this code with a teammate who wants to invite you.</p>
            <code className="cb-member-code">{account.id}</code>
            <button
              className="cb-button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(account.id);
                  setCopied("Member code copied.");
                } catch {
                  setCopied("Select and copy the code above.");
                }
              }}
            >
              Copy member code
            </button>
            <p role="status">{copied}</p>
          </div>
          <TeamCreate account={account} onCreated={refresh} />
        </aside>
      </div>
    </>
  );
}
