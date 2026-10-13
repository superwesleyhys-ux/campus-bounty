"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useMutation } from "./api";
import type { Account } from "./types";
import { Feedback, Field, PendingButton } from "./ui";
import { Eligibility } from "./eligibility";
import { eligibilityDate, resultUncertain } from "./eligibility-types";

function ProfileEditor({
  account,
  onAccountChanged,
}: {
  account: Account;
  onAccountChanged: () => void;
}) {
  const [name, setName] = useState(account.display_name);
  const [bio, setBio] = useState(account.bio || "");
  const [saved, setSaved] = useState({
    name: account.display_name,
    bio: account.bio || "",
  });
  const mutation = useMutation(account.id);
  const dirty = name !== saved.name || bio !== saved.bio;
  const uncertain = resultUncertain(mutation.error);
  const [recovered, setRecovered] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const clear = mutation.clear;
  useEffect(() => {
    if (
      uncertain &&
      account.display_name === name.trim() &&
      (account.bio || "") === bio.trim()
    ) {
      setName(account.display_name);
      setBio(account.bio || "");
      setSaved({ name: account.display_name, bio: account.bio || "" });
      clear();
      setRecovered(
        "Your changes are saved. The current profile matches these entries.",
      );
      heading.current?.focus();
    }
  }, [account.display_name, account.bio, uncertain, name, bio, clear]);
  // Keep edits intact during background account refreshes. Clean forms follow
  // the saved profile, including changes made in another browser tab.
  useEffect(() => {
    if (!dirty) {
      setName(account.display_name);
      setBio(account.bio || "");
      setSaved({ name: account.display_name, bio: account.bio || "" });
    }
  }, [account.display_name, account.bio]);
  return (
    <section className="cb-panel" aria-labelledby="profile-heading">
      <h2 id="profile-heading" ref={heading} tabIndex={-1}>
        Your profile
      </h2>
      <p>
        Your display name identifies you to teammates and people you work with.
        Keep private contact details out of your bio.
      </p>
      <Feedback {...mutation} />
      <Feedback notice={recovered} />
      {uncertain && (
        <p className="cb-alert">
          Your changes may already have been saved. Check the current profile or
          retry the same save to recover the result. Leaving this page will not
          undo a saved change.
        </p>
      )}
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setRecovered("");
          const result = await mutation.run<Account>(
            "me",
            { displayName: name.trim(), bio: bio.trim() },
            "Profile saved.",
            "PATCH",
          );
          if (result) {
            setName(result.display_name);
            setBio(result.bio);
            setSaved({ name: result.display_name, bio: result.bio });
            onAccountChanged();
            try {
              localStorage.setItem(
                "campus:account-version",
                crypto.randomUUID(),
              );
            } catch {
              /* optional cross-tab synchronization */
            }
          }
        }}
      >
        <Field
          label="Display name"
          help="Use the name you want your campus community to see."
        >
          <input
            autoComplete="name"
            required
            maxLength={100}
            value={name}
            disabled={mutation.busy || uncertain}
            onChange={(e) => {
              setName(e.target.value);
              mutation.clear();
              setRecovered("");
            }}
          />
        </Field>
        <Field
          label="Short bio"
          help={`${bio.length}/500 characters. Optional: your interests, skills or what you like working on.`}
        >
          <textarea
            rows={4}
            maxLength={500}
            value={bio}
            disabled={mutation.busy || uncertain}
            onChange={(e) => {
              setBio(e.target.value);
              mutation.clear();
              setRecovered("");
            }}
          />
        </Field>
        <div className="cb-actions">
          <PendingButton busy={mutation.busy} disabled={!name.trim() || !dirty}>
            {uncertain ? "Retry the same save" : "Save profile"}
          </PendingButton>
          <button
            type="button"
            className="cb-button"
            disabled={!dirty || mutation.busy}
            onClick={() => {
              if (uncertain) {
                onAccountChanged();
                return;
              }
              setName(account.display_name);
              setBio(account.bio || "");
              setSaved({ name: account.display_name, bio: account.bio || "" });
              mutation.clear();
            }}
          >
            {uncertain ? "Check current profile" : "Discard changes"}
          </button>
        </div>
        {dirty && !uncertain && (
          <p className="cb-fine">
            You have unsaved changes. Save them before leaving this page.
          </p>
        )}
      </form>
    </section>
  );
}

export function AccountPage({
  account,
  onAccountChanged,
}: {
  account: Account;
  onAccountChanged: () => void;
}) {
  return (
    <>
      <div className="cb-heading">
        <div>
          <span className="cb-eyebrow">Your campus identity</span>
          <h1>Your account</h1>
          <p>Manage your profile and student eligibility in one place.</p>
        </div>
        <button className="cb-button" onClick={onAccountChanged}>
          Refresh account
        </button>
      </div>
      <div className="cb-detail-grid">
        <div>
          <ProfileEditor
            account={account}
            onAccountChanged={onAccountChanged}
          />
          <Eligibility account={account} onAccountChanged={onAccountChanged} />
        </div>
        <aside
          className="cb-panel cb-account-summary"
          aria-labelledby="membership-heading"
        >
          <h2 id="membership-heading">Campus membership</h2>
          <p>
            <strong>
              {account.institution_name || "No current university"}
            </strong>
          </p>
          <p>
            {account.campus_verified
              ? "University email verified"
              : "University email verification needed"}
          </p>
          {account.affiliation_valid_until && (
            <p className="cb-fine">
              Email verification valid until{" "}
              {eligibilityDate(account.affiliation_valid_until)}.
            </p>
          )}
          <p>
            Email verification lets you explore and post listings. Reviewed
            student eligibility is required to apply for bounties and join
            teams.
          </p>
          {account.can_review_eligibility && (
            <Link className="cb-button" href="/?view=eligibility-review">
              Review student requests
            </Link>
          )}
          <Link className="cb-text-button" href="/?view=workspace">
            View your existing activity →
          </Link>
        </aside>
      </div>
    </>
  );
}
