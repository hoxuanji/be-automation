import { cloudVerifyRoute } from "@/lib/cloud-verify-route";
import { verifyAzure } from "@/lib/cloud-verify";

export const runtime = "nodejs";

// POST /api/azure/verify — body: the azure credential fields (see CLOUD_CRED_SCHEMAS).
export const POST = cloudVerifyRoute("azure", verifyAzure);
