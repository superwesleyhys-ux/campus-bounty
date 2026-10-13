"use client";
import { useState } from "react";
import { useMutation, useResource } from "./api";
import { Feedback, Field, PendingButton } from "./ui";
import { universityForEmail } from "@/lib/university-email.mjs";

export function SignIn({
  onSuccess,
  local,
  sample = false,
  expired = false,
}: {
  onSuccess: () => void;
  local: boolean;
  sample?: boolean;
  expired?: boolean;
}) {
  const [email, setEmail] = useState(""),
    [challenge, setChallenge] = useState<string | null>(null);
  const mutation = useMutation("auth"),
    directory = useResource<{ name: string; domain: string }[]>("institutions");
  const school = universityForEmail(email, directory.data || []);
  const unsupported =
    !sample && !!directory.data && email.includes("@") && !school;
  const emailHelp = sample
    ? "Real email delivery is unavailable in this local preview, including Berkeley and other university addresses. Choose a sample account above; your email will not be used or converted into a sample identity."
    : directory.loading
      ? "Checking the university directory…"
      : directory.error
        ? "The university directory could not be loaded. Retry below before continuing."
        : unsupported
          ? "This email domain is not supported. Use your approved U.S. university email, not a personal email address."
          : school
            ? `School domain recognized: ${school.name}. You still need to verify ownership with a sign-in code.`
            : "Only email domains in our approved U.S. university directory are accepted. An .edu ending alone is not enough.";
  return (
    <div className="cb-signin">
      <section className="cb-welcome">
        <span className="cb-eyebrow">Your campus. Your next opportunity.</span>
        <h1>
          Good ideas need
          <br />
          good people.
        </h1>
        <p>
          Find a research project. Bring a team together. Give your pre-loved
          things a new home.
        </p>
        <ol>
          <li>
            {sample
              ? "Choose a local sample account"
              : "Verify your university email"}
          </li>
          <li>Explore bounties and campus listings</li>
          <li>Keep every collaboration in one workspace</li>
        </ol>
      </section>
      <section className="cb-panel">
        <span className="cb-eyebrow">
          {sample ? "Local sample preview" : "Members only"}
        </span>
        <h2>{challenge ? "Check your inbox" : "Welcome to Campus Bounty"}</h2>
        <p>
          {expired
            ? "Your session ended. Sign in to continue where you left off."
            : sample
              ? "Explore with a sample account. We’ll keep your selected page."
              : "Use your university email to join your campus community. We’ll keep your place."}
        </p>
        {sample && (
          <section aria-label="Sample-account entry">
            <h3>Try a sample account</h3>
            <p className="cb-alert">
              These are synthetic sample accounts. No real university
              verification, external email or actual payment takes place.
            </p>
            <div className="cb-actions">
              {(["student", "applicant", "publisher"] as const).map((role) => (
                <button
                  key={role}
                  type="button"
                  className={`cb-button ${role === "student" ? "cb-primary" : ""}`}
                  disabled={mutation.busy}
                  onClick={async () => {
                    const result = await mutation.run(
                      "auth/preview",
                      { role },
                      "",
                    );
                    if (result) onSuccess();
                  }}
                >
                  {role === "student"
                    ? "Enter as Alex · eligible student"
                    : role === "applicant"
                      ? "Enter as Sam · eligible student"
                      : "Enter as Professor · publisher"}
                </button>
              ))}
            </div>
          </section>
        )}
        {local && !sample && (
          <p className="cb-alert">
            Local testing: only synthetic campus.example.test addresses are
            enabled. Messages go to the private local mail sink.
          </p>
        )}
        <Feedback {...mutation} />
        {!challenge ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (sample || directory.loading || directory.error || !school)
                return;
              const r = await mutation.run<{ challengeId: string }>(
                "auth/challenges",
                { email: email.trim() },
                "",
              );
              if (r) setChallenge(r.challengeId);
            }}
          >
            <Field label="University email" help={emailHelp}>
              <input
                required
                type="email"
                autoComplete="email"
                maxLength={254}
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  mutation.clear();
                }}
                aria-invalid={unsupported || undefined}
                placeholder="you@university.edu"
              />
            </Field>
            {directory.error && (
              <button
                type="button"
                className="cb-button"
                onClick={directory.reload}
              >
                Retry university check
              </button>
            )}
            <PendingButton
              busy={mutation.busy}
              disabled={
                sample || directory.loading || !!directory.error || !school
              }
            >
              {sample
                ? "Real email delivery unavailable"
                : "Email me a sign-in code"}
            </PendingButton>
            {!sample && (
              <details className="cb-help">
                <summary>Which university emails are supported?</summary>
                <p>
                  Access uses a reviewed university directory. An .edu suffix
                  alone does not grant membership.
                </p>
                {directory.data?.map((d) => (
                  <p key={d.domain}>
                    {d.name} · {d.domain}
                  </p>
                ))}
              </details>
            )}
          </form>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              const r = await mutation.run(
                "auth/sessions",
                {
                  challengeId: challenge,
                  code: String(form.get("code")),
                  displayName: String(form.get("name")),
                },
                "Signed in.",
              );
              if (r) onSuccess();
            }}
          >
            <p>
              A six-digit sign-in code has been queued for{" "}
              <strong>{email}</strong>. Check your inbox and spam folder. Codes
              expire after 10 minutes.
            </p>
            <Field label="Sign-in code">
              <input
                name="code"
                required
                pattern="[0-9]{6}"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
              />
            </Field>
            <Field
              label="Your display name"
              help="For a new account, we’ll use this name. Returning members keep their saved name and can change it in Account after signing in."
            >
              <input name="name" required maxLength={100} autoComplete="name" />
            </Field>
            <PendingButton busy={mutation.busy}>
              Verify and continue
            </PendingButton>
            <button
              type="button"
              className="cb-text-button"
              disabled={mutation.busy}
              onClick={() => {
                setChallenge(null);
                mutation.clear();
              }}
            >
              Change email or request a new code
            </button>
          </form>
        )}
        <p className="cb-fine">
          {sample
            ? "Sample access is limited to this disposable local preview. Use the visible account switcher after signing in."
            : "Email verification establishes campus membership. Taking on bounties also requires reviewed student eligibility."}
        </p>
      </section>
    </div>
  );
}
