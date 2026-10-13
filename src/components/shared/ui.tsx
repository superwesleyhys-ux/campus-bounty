"use client";
import { cloneElement, useId, type ReactNode, type ReactElement } from "react";
import { ApiError } from "./api";

export function Feedback({
  error,
  notice,
}: {
  error?: Error | null;
  notice?: string;
}) {
  return (
    <>
      {error && (
        <div className="cb-alert cb-error" role="alert">
          <strong>We couldn’t finish that.</strong>
          <p>{error.message}</p>
          {error instanceof ApiError && error.requestId && (
            <details>
              <summary>Support reference</summary>
              <code>{error.requestId}</code>
            </details>
          )}
        </div>
      )}
      {notice && (
        <p className="cb-alert cb-success" role="status">
          {notice}
        </p>
      )}
    </>
  );
}
export function ResourceState({
  loading,
  error,
  reload,
}: {
  loading: boolean;
  error?: Error;
  reload: () => void;
}) {
  if (error)
    return (
      <div className="cb-panel">
        <Feedback error={error} />
        <button className="cb-button" onClick={reload}>
          Try again
        </button>
      </div>
    );
  if (loading)
    return (
      <p className="cb-loading" role="status">
        Loading your campus…
      </p>
    );
  return null;
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="cb-empty">
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}
export function Field({
  label,
  children,
  help,
}: {
  label: string;
  children: ReactElement<{ id?: string; "aria-describedby"?: string }>;
  help?: string;
}) {
  const id = useId();
  return (
    <div className="cb-field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, {
        id,
        "aria-describedby": help ? `${id}-help` : undefined,
      })}
      {help && <small id={`${id}-help`}>{help}</small>}
    </div>
  );
}
export function Status({ value }: { value: string }) {
  return (
    <span className={`cb-badge cb-${value}`}>
      {value === "superseded"
        ? "Not selected"
        : value === "pending_payment"
          ? "Unpaid reservation"
          : value.replaceAll("_", " ")}
    </span>
  );
}
export function PendingButton({
  busy,
  children,
  disabled = false,
}: {
  busy: boolean;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      className="cb-button cb-primary"
      type="submit"
      disabled={busy || disabled}
    >
      {busy ? "Saving…" : children}
    </button>
  );
}
