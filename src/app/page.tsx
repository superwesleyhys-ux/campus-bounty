import Campus from "@/components/campus";
import SharedCampus from "@/components/shared/app";
import { Suspense } from "react";
export const dynamic = "force-dynamic";
export default function Page() {
  return process.env.CAMPUS_BACKEND === "postgres" ? (
    <Suspense fallback={<p>Opening Campus Bounty…</p>}>
      <SharedCampus
        local={process.env.NODE_ENV !== "production"}
        audit={
          process.env.CAMPUS_BUILD_DIR === ".next-interaction" &&
          process.env.NODE_ENV !== "production"
        }
      />
    </Suspense>
  ) : (
    <Campus />
  );
}
