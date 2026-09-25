import { cloudVerifyRoute } from "@/lib/cloud-verify-route";
import { verifyK8s } from "@/lib/cloud-verify";

export const runtime = "nodejs";

// POST /api/k8s/verify — body: the k8s credential fields (see CLOUD_CRED_SCHEMAS).
export const POST = cloudVerifyRoute("k8s", verifyK8s);
