"use client";
import { useEffect, useRef, useState } from "react";

export function ConfirmAction({
  label,
  description,
  confirmLabel,
  busy,
  disabled = false,
  onConfirm,
  headingLevel = 4,
  cancelLabel = "Keep application",
  uncertain = false,
  onCheckStatus,
}: {
  label: string;
  description: string;
  confirmLabel: string;
  busy: boolean;
  disabled?: boolean;
  onConfirm: () => Promise<boolean>;
  headingLevel?: 3 | 4;
  cancelLabel?: string;
  uncertain?: boolean;
  onCheckStatus?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancelled = useRef(false);
  const Heading = headingLevel === 3 ? "h3" : "h4";
  useEffect(() => {
    if (open) heading.current?.focus();
    else if (cancelled.current) trigger.current?.focus();
    cancelled.current = false;
  }, [open]);
  if (!open)
    return (
      <button
        ref={trigger}
        type="button"
        className="cb-button"
        disabled={busy || disabled}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
    );
  return (
    <div className="cb-alert">
      <Heading ref={heading} tabIndex={-1}>
        {label}?
      </Heading>
      <p>{description}</p>
      {uncertain && (
        <p role="status">
          The last request may already have completed. Check the current status
          or retry to recover its result. Closing this panel cannot undo it.
        </p>
      )}
      <div className="cb-actions">
        <button
          type="button"
          className="cb-button"
          disabled={busy}
          onClick={() => {
            if (uncertain) {
              onCheckStatus?.();
              return;
            }
            cancelled.current = true;
            setOpen(false);
          }}
        >
          {uncertain ? "Check current status" : cancelLabel}
        </button>
        <button
          type="button"
          className="cb-button cb-primary"
          disabled={busy || disabled}
          onClick={async () => {
            if (await onConfirm()) setOpen(false);
          }}
        >
          {busy ? "Saving…" : confirmLabel}
        </button>
      </div>
    </div>
  );
}
