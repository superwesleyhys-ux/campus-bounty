"use client";
import { useState } from "react";
// Exposed only by the disposable local fixture, never by a production build.
export function LocalAudit() {
  const [result, setResult] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <aside data-qa="true" aria-label="Local accessibility test tools">
      <details>
        <summary>Local test tools</summary>
        <button
          className="cb-button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const axe = (await import("axe-core")).default;
              const report = await axe.run({ exclude: [["[data-qa]"]] });
              setResult(
                JSON.stringify(
                  {
                    url: location.href,
                    width: innerWidth,
                    violations: report.violations.map((v) => ({
                      id: v.id,
                      impact: v.impact,
                      description: v.description,
                      nodes: v.nodes.map((n) => ({
                        target: n.target,
                        summary: n.failureSummary,
                      })),
                    })),
                    passes: report.passes.length,
                    incomplete: report.incomplete.map((v) => v.id),
                  },
                  null,
                  2,
                ),
              );
            } catch (error) {
              setResult(String(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          Run accessibility audit
        </button>
        <pre aria-live="polite">{result}</pre>
      </details>
    </aside>
  );
}
