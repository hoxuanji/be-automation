import { cloudVerifyRoute } from "@/lib/cloud-verify-route";
import { verifyAws } from "@/lib/cloud-verify";

export const runtime = "nodejs";

// POST /api/aws/verify — body: the aws credential fields (see CLOUD_CRED_SCHEMAS).
export const POST = cloudVerifyRoute("aws", verifyAws);
