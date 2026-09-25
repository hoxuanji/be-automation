import { cloudVerifyRoute } from "@/lib/cloud-verify-route";
import { verifyGcp } from "@/lib/cloud-verify";

export const runtime = "nodejs";

// POST /api/gcp/verify — body: the gcp credential fields (see CLOUD_CRED_SCHEMAS).
export const POST = cloudVerifyRoute("gcp", verifyGcp);
