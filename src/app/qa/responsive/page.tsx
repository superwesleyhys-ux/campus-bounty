import { notFound } from "next/navigation";
export const dynamic = "force-dynamic";
// Real same-origin iframe viewports when the browser's emulation API is unavailable.
// The route is absent outside the disposable development fixture.
export default async function ResponsiveQA({
  searchParams,
}: {
  searchParams: Promise<{ width?: string; view?: string }>;
}) {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.CAMPUS_BUILD_DIR !== ".next-interaction"
  )
    notFound();
  const params = await searchParams,
    width = [320, 768, 1024, 1440].includes(Number(params.width))
      ? Number(params.width)
      : 320;
  const view = ["bounties", "market", "publish", "workspace", "teams"].includes(
    params.view || "",
  )
    ? params.view!
    : "bounties";
  return (
    <main style={{ padding: 16, fontFamily: "Arial,sans-serif" }}>
      <h1>Local responsive verification</h1>
      <form>
        <label>
          Viewport width{" "}
          <select name="width" defaultValue={width}>
            {[320, 768, 1024, 1440].map((w) => (
              <option key={w}>{w}</option>
            ))}
          </select>
        </label>{" "}
        <label>
          Screen{" "}
          <select name="view" defaultValue={view}>
            {["bounties", "market", "publish", "workspace", "teams"].map(
              (v) => (
                <option key={v}>{v}</option>
              ),
            )}
          </select>
        </label>{" "}
        <button>Apply viewport</button>
      </form>
      <p>
        These are real CSS viewport widths. This is not mobile hardware or a
        soft-keyboard test.
      </p>
      <iframe
        title="Responsive Campus Bounty"
        src={`/?view=${view}`}
        width={width}
        height={900}
        style={{
          border: "1px solid #aaa",
          display: "block",
          maxWidth: "none",
          boxSizing: "content-box",
        }}
      />
    </main>
  );
}
