// Client-safe metadata for the GitHub-Actions-driven cloud deploy targets
// (AWS / GCP / Azure / Kubernetes). Shared by Settings → Integrations, the
// Deploy page, /api/deploy/credentials and the /api/<cloud>/verify routes so
// field names and validation never drift. Server-only logic (secret upload,
// workflow dispatch) lives in `cloud-deploy.ts`.

import { z } from "zod";

export type CloudProvider = "aws" | "gcp" | "azure" | "k8s";

export const CLOUD_PROVIDERS: readonly CloudProvider[] = ["aws", "gcp", "azure", "k8s"];

export function isCloudProvider(id: string): id is CloudProvider {
  return (CLOUD_PROVIDERS as readonly string[]).includes(id);
}

// Stored credential shapes (encrypted in users.deploy_creds_enc, one entry per
// provider). Each maps 1:1 onto the Actions secrets in CLOUD_SECRET_NAMES.
export const CLOUD_CRED_SCHEMAS = {
  // AWS region is not a credential — deploy.yml bakes in config.region.
  aws: z.object({
    accessKeyId: z.string().trim().regex(/^[A-Z0-9]{16,128}$/, "Access key ID looks malformed."),
    secretAccessKey: z.string().trim().min(16).max(512),
  }),
  // Project id is read from the key itself.
  gcp: z.object({
    serviceAccountKey: z.string().trim().min(100).max(16_000),
  }),
  // Assembled into the AZURE_CREDENTIALS sdk-auth JSON at deploy time.
  azure: z.object({
    tenantId: z.string().trim().uuid("Tenant ID must be a GUID."),
    clientId: z.string().trim().uuid("Client ID must be a GUID."),
    clientSecret: z.string().trim().min(1).max(512),
    subscriptionId: z.string().trim().uuid("Subscription ID must be a GUID."),
  }),
  // Raw kubeconfig YAML, stored verbatim in KUBECONFIG (GitHub caps secrets at 48 KB).
  k8s: z.object({
    kubeconfig: z.string().trim().min(50).max(48_000),
  }),
} as const;

export type CloudCreds<P extends CloudProvider> = z.infer<(typeof CLOUD_CRED_SCHEMAS)[P]>;

export type CloudField = {
  key: string;
  label: string;
  placeholder: string;
  secret?: boolean;
  multiline?: boolean;
};

export const CLOUD_META: Record<
  CloudProvider,
  { label: string; credsLabel: string; docsUrl: string; docsText: string; fields: CloudField[] }
> = {
  aws: {
    label: "AWS",
    credsLabel: "IAM access key",
    docsUrl: "https://console.aws.amazon.com/iam/home#/security_credentials",
    docsText: "IAM → Security credentials",
    fields: [
      { key: "accessKeyId", label: "Access key ID", placeholder: "AKIAXXXXXXXXXXXXXXXX" },
      { key: "secretAccessKey", label: "Secret access key", placeholder: "••••••••", secret: true },
    ],
  },
  gcp: {
    label: "GCP",
    credsLabel: "service account key",
    docsUrl: "https://console.cloud.google.com/iam-admin/serviceaccounts",
    docsText: "IAM → Service accounts → Keys",
    fields: [
      { key: "serviceAccountKey", label: "Service account key (JSON)", placeholder: '{ "type": "service_account", … }', secret: true, multiline: true },
    ],
  },
  azure: {
    label: "Azure",
    credsLabel: "service principal",
    docsUrl: "https://learn.microsoft.com/azure/developer/github/connect-from-azure-secret",
    docsText: "az ad sp create-for-rbac --sdk-auth",
    fields: [
      { key: "tenantId", label: "Tenant ID", placeholder: "00000000-0000-0000-0000-000000000000" },
      { key: "clientId", label: "Client ID", placeholder: "00000000-0000-0000-0000-000000000000" },
      { key: "clientSecret", label: "Client secret", placeholder: "••••••••", secret: true },
      { key: "subscriptionId", label: "Subscription ID", placeholder: "00000000-0000-0000-0000-000000000000" },
    ],
  },
  k8s: {
    label: "Kubernetes",
    credsLabel: "kubeconfig",
    docsUrl: "https://kubernetes.io/docs/concepts/configuration/organize-cluster-access-kubeconfig/",
    docsText: "kubeconfig docs",
    fields: [
      { key: "kubeconfig", label: "Kubeconfig (YAML, token or client-cert auth)", placeholder: "apiVersion: v1\nkind: Config\n…", secret: true, multiline: true },
    ],
  },
};
