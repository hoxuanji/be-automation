// Continuous-deployment emitters: one real deploy job per `config.deployment`
// target for GitHub Actions (.github/workflows/deploy.yml), GitLab CI and
// CircleCI, plus the provider config files those jobs read (fly.toml,
// railway.json). Secret names live in DEPLOY_SECRETS so the one-click deploy
// flow and DEPLOY.md can't drift from what the workflows reference.
import type { StackConfig } from "./types";
import { safeName } from "./types";

type Deployment = "vercel" | "railway" | "render" | "fly" | "aws" | "gcp" | "azure" | "k8s";

export type DeploySecret = { name: string; required: boolean; description: string };

// Exact CI secret names each target's deploy job reads. Same names on
// GitHub Actions (repo secrets), GitLab (CI/CD variables) and CircleCI (env vars).
export const DEPLOY_SECRETS: Record<Deployment, DeploySecret[]> = {
  vercel: [
    { name: "VERCEL_TOKEN", required: true, description: "Vercel access token (vercel.com/account/tokens)" },
    { name: "VERCEL_ORG_ID", required: true, description: "Team/user id (`orgId` in .vercel/project.json after `vercel link`)" },
    { name: "VERCEL_PROJECT_ID", required: true, description: "Project id (`projectId` in .vercel/project.json)" },
  ],
  railway: [
    { name: "RAILWAY_TOKEN", required: true, description: "Railway *project* token (Project → Settings → Tokens)" },
    { name: "RAILWAY_SERVICE_ID", required: true, description: "Id of the Railway service to deploy into" },
  ],
  render: [
    { name: "RENDER_API_KEY", required: true, description: "Render API key (Account Settings → API Keys)" },
    { name: "RENDER_SERVICE_ID", required: true, description: "Web service id (`srv-…`, from the service URL)" },
  ],
  fly: [{ name: "FLY_API_TOKEN", required: true, description: "`flyctl tokens create deploy` output" }],
  aws: [
    { name: "AWS_ROLE_ARN", required: false, description: "IAM role to assume via GitHub OIDC (preferred; GitHub Actions only)" },
    { name: "AWS_ACCESS_KEY_ID", required: false, description: "Access key — required unless AWS_ROLE_ARN is set" },
    { name: "AWS_SECRET_ACCESS_KEY", required: false, description: "Secret key — required unless AWS_ROLE_ARN is set" },
  ],
  gcp: [{ name: "GCP_SA_KEY", required: true, description: "Service-account JSON key (roles: run.admin, artifactregistry.admin, iam.serviceAccountUser)" }],
  azure: [{ name: "AZURE_CREDENTIALS", required: true, description: "`az ad sp create-for-rbac --sdk-auth` JSON (clientId, clientSecret, tenantId, subscriptionId)" }],
  k8s: [
    { name: "KUBECONFIG", required: true, description: "Full kubeconfig file contents for the target cluster" },
    { name: "K8S_SECRETS_ENV", required: false, description: "dotenv contents synced into the app's `<name>-env` Secret on every deploy" },
  ],
};

const LABEL: Record<Deployment, string> = {
  vercel: "Vercel", railway: "Railway", render: "Render", fly: "Fly.io",
  aws: "AWS ECS Fargate", gcp: "Google Cloud Run", azure: "Azure Container Apps", k8s: "Kubernetes",
};

export const deployTarget = (c: StackConfig): Deployment =>
  (c.deployment in DEPLOY_SECRETS ? c.deployment : "k8s") as Deployment;

// ─── Scaling / naming helpers (shared with the IaC emitters in common.ts) ────

// `serverless` scales to zero on platforms that support it; everything else
// keeps the configured baseline warm.
export function minInstances(config: StackConfig): number {
  return config.scaling === "serverless" ? 0 : config.replicas;
}

export function maxInstances(config: StackConfig): number {
  return config.autoscale ? Math.max(config.replicas * 4, 10) : Math.max(config.replicas, 1);
}

// ACR names must be 5-50 alphanumeric characters — no dashes.
export function acrName(name: string): string {
  return `${name.replace(/[^a-z0-9]/g, "")}registry`;
}

// The builder's region picker uses AWS ids; translate to each provider's own.
const REGIONS: Record<string, { gcp: string; azure: string; fly: string }> = {
  "us-east-1": { gcp: "us-east1", azure: "eastus", fly: "iad" },
  "us-west-2": { gcp: "us-west1", azure: "westus2", fly: "sea" },
  "eu-west-2": { gcp: "europe-west2", azure: "uksouth", fly: "lhr" },
  "ap-south-1": { gcp: "asia-south1", azure: "centralindia", fly: "bom" },
  "sa-east-1": { gcp: "southamerica-east1", azure: "brazilsouth", fly: "gru" },
  "ap-southeast-2": { gcp: "australia-southeast1", azure: "australiaeast", fly: "syd" },
};

export function providerRegion(config: StackConfig, provider: "gcp" | "azure" | "fly"): string {
  // ponytail: unknown ids pass through unchanged, assumed already provider-native.
  return REGIONS[config.region]?.[provider] ?? config.region;
}

// Vercel only runs zero-config serverless backends (Node frameworks, FastAPI);
// no Dockerfile, no gRPC.
export function vercelSupported(config: StackConfig): boolean {
  if (config.api === "grpc") return false;
  return config.language === "typescript" || (config.language === "python" && config.framework === "fastapi");
}

const lowerOwner = (c: StackConfig) => (c.owner || "your-org").toLowerCase();

// ─── Shared shell ────────────────────────────────────────────────────────────

// POSIX sh; needs curl + jq. Expects SHA, RENDER_API_KEY, RENDER_SERVICE_ID.
const RENDER_SCRIPT = [
  `id=$(curl -fsS -X POST "https://api.render.com/v1/services/$RENDER_SERVICE_ID/deploys" -H "Authorization: Bearer $RENDER_API_KEY" -H "Accept: application/json" -H "Content-Type: application/json" -d "{\\"commitId\\":\\"$SHA\\"}" | jq -r .id)`,
  `echo "Render deploy $id started"`,
  `for _ in $(seq 1 90); do`,
  `  status=$(curl -fsS "https://api.render.com/v1/services/$RENDER_SERVICE_ID/deploys/$id" -H "Authorization: Bearer $RENDER_API_KEY" -H "Accept: application/json" | jq -r .status)`,
  `  echo "status: $status"`,
  `  case "$status" in live) exit 0 ;; build_failed|update_failed|pre_deploy_failed|canceled|deactivated) exit 1 ;; esac`,
  `  sleep 10`,
  `done`,
  `echo "Timed out waiting for Render deploy $id"; exit 1`,
];

function vercelUnsupportedLine(config: StackConfig): string {
  return `echo "Vercel cannot run a ${config.language}/${config.framework}${config.api === "grpc" ? " gRPC" : ""} server (serverless Node or FastAPI only). Pick railway, render, fly or a container platform." >&2; exit 1`;
}

// Shell deploy for GitLab CI / CircleCI. `SHA` and `REGISTRY_IMAGE` are set by the caller.
function shellDeployScript(config: StackConfig): string[] {
  const name = safeName(config.name);
  const r = config.region;
  switch (deployTarget(config)) {
    case "fly":
      return [
        "curl -fsSL https://fly.io/install.sh | sh",
        'export PATH="$HOME/.fly/bin:$PATH"',
        `flyctl deploy --remote-only --app ${name} --image-label "$SHA"`,
        `flyctl scale count ${flyCount(config)} --app ${name} --yes`,
      ];
    case "railway":
      return ["npm install -g @railway/cli", 'railway up --ci --service "$RAILWAY_SERVICE_ID"'];
    case "render":
      return RENDER_SCRIPT;
    case "vercel":
      if (!vercelSupported(config)) return [vercelUnsupportedLine(config)];
      return [
        "npm install -g vercel@latest",
        'vercel pull --yes --environment=production --token="$VERCEL_TOKEN"',
        'vercel build --prod --token="$VERCEL_TOKEN"',
        'vercel deploy --prebuilt --prod --token="$VERCEL_TOKEN"',
      ];
    case "aws":
      return [
        `export AWS_DEFAULT_REGION=${r}`,
        "ACCOUNT=$(aws sts get-caller-identity --query Account --output text)",
        `REGISTRY=$ACCOUNT.dkr.ecr.${r}.amazonaws.com`,
        `aws ecr describe-repositories --repository-names ${name} >/dev/null 2>&1 || aws ecr create-repository --repository-name ${name} >/dev/null`,
        'aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY"',
        `IMAGE="$REGISTRY/${name}:$SHA"`,
        'docker build -t "$IMAGE" .',
        'docker push "$IMAGE"',
        `sed "s/\\\${AWS_ACCOUNT_ID}/$ACCOUNT/g" deploy/aws/task-definition.json | jq --arg img "$IMAGE" '.containerDefinitions[0].image = $img' > task-definition.json`,
        "TASK_DEF=$(aws ecs register-task-definition --cli-input-json file://task-definition.json --query taskDefinition.taskDefinitionArn --output text)",
        `aws ecs update-service --cluster ${name} --service ${name} --task-definition "$TASK_DEF" --desired-count ${config.replicas} >/dev/null`,
        `aws ecs wait services-stable --cluster ${name} --services ${name}`,
      ];
    case "gcp": {
      const gr = providerRegion(config, "gcp");
      return [
        'printf \'%s\' "$GCP_SA_KEY" > /tmp/gcp-key.json',
        "gcloud auth activate-service-account --key-file=/tmp/gcp-key.json",
        "PROJECT=$(jq -r .project_id /tmp/gcp-key.json)",
        'gcloud config set project "$PROJECT"',
        `gcloud artifacts repositories describe ${name} --location ${gr} >/dev/null 2>&1 || gcloud artifacts repositories create ${name} --repository-format=docker --location ${gr}`,
        `IMAGE=${gr}-docker.pkg.dev/$PROJECT/${name}/${name}:$SHA`,
        "# Cloud Build builds the Dockerfile remotely — no Docker daemon needed here.",
        'gcloud builds submit --tag "$IMAGE" .',
        `sed -e "s/\\\${GCP_PROJECT_ID}/$PROJECT/g" -e "s|/${name}:latest|/${name}:$SHA|" deploy/gcp/service.yaml > service.yaml`,
        `gcloud run services replace service.yaml --region ${gr}`,
      ];
    }
    case "azure": {
      const acr = acrName(name);
      return [
        'az login --service-principal -u "$(echo "$AZURE_CREDENTIALS" | jq -r .clientId)" -p "$(echo "$AZURE_CREDENTIALS" | jq -r .clientSecret)" --tenant "$(echo "$AZURE_CREDENTIALS" | jq -r .tenantId)"',
        'az account set --subscription "$(echo "$AZURE_CREDENTIALS" | jq -r .subscriptionId)"',
        "az config set extension.use_dynamic_install=yes_without_prompt",
        "# ACR Tasks builds the Dockerfile remotely — no Docker daemon needed here.",
        `az acr build --registry ${acr} --image ${name}:$SHA .`,
        `az containerapp update --name ${name} --resource-group ${name}-rg --image ${acr}.azurecr.io/${name}:$SHA --min-replicas ${minInstances(config)} --max-replicas ${maxInstances(config)}`,
      ];
    }
    case "k8s":
      return [
        'IMAGE="$REGISTRY_IMAGE:$SHA"',
        'docker build -t "$IMAGE" .',
        'docker push "$IMAGE"',
        'if [ ! -f "$KUBECONFIG" ]; then printf \'%s\' "$KUBECONFIG" > /tmp/kubeconfig; export KUBECONFIG=/tmp/kubeconfig; fi',
        ...k8sRollout(config),
      ];
  }
}

// kubectl/helm commands shared by every CI provider. Expects IMAGE.
function k8sRollout(config: StackConfig): string[] {
  const name = safeName(config.name);
  const ns = name;
  const lines = [
    `kubectl create namespace ${ns} --dry-run=client -o yaml | kubectl apply -f -`,
    `if [ -n "\${K8S_SECRETS_ENV:-}" ]; then printf '%s\\n' "$K8S_SECRETS_ENV" > /tmp/app.env; kubectl create secret generic ${name}-env -n ${ns} --from-env-file=/tmp/app.env --dry-run=client -o yaml | kubectl apply -f -; fi`,
  ];
  if (config.cicd === "argo") {
    return [`echo "Image $IMAGE pushed. Argo CD (deploy/argocd/application.yaml) syncs the cluster from git — bump the image tag there (or run Argo CD Image Updater) to roll it out."`];
  }
  if (config.kubernetes || !config.helm) {
    lines.push(
      `sed -i "s|image: .*/${name}:latest|image: $IMAGE|" deploy/k8s/deployment.yaml`,
      `kubectl apply -n ${ns} -f deploy/k8s/`,
      `kubectl rollout status deployment/${name} -n ${ns} --timeout=5m`,
    );
  } else {
    lines.push(
      "helm dependency update ./deploy/helm",
      `helm upgrade --install ${name} ./deploy/helm -n ${ns} --create-namespace --set image.repository="\${IMAGE%:*}" --set image.tag="$SHA" --wait --timeout 5m`,
    );
  }
  return lines;
}

const flyCount = (c: StackConfig) => (c.autoscale ? maxInstances(c) : Math.max(c.replicas, 1));

// ─── GitHub Actions ──────────────────────────────────────────────────────────

const step = (name: string, run: string[], extra = "") =>
  `      - name: ${name}\n${extra}        run: |\n${run.map((l) => `          ${l}`).join("\n")}`;

function ghaDeploySteps(config: StackConfig): { permissions: string; env: string; steps: string } {
  const name = safeName(config.name);
  const sec = (s: string) => `\${{ secrets.${s} }}`;
  const envBlock = (vars: string[]) => `        env:\n${vars.map((v) => `          ${v}: ${sec(v)}`).join("\n")}\n`;
  const read = "      contents: read";
  switch (deployTarget(config)) {
    case "fly":
      return {
        permissions: read,
        env: "",
        steps: [
          step("Install flyctl", ["curl -fsSL https://fly.io/install.sh | sh", 'echo "$HOME/.fly/bin" >> "$GITHUB_PATH"']),
          step("Deploy to Fly.io", [
            `flyctl deploy --remote-only --app ${name} --image-label "$GITHUB_SHA"`,
            `flyctl scale count ${flyCount(config)} --app ${name} --yes`,
          ], envBlock(["FLY_API_TOKEN"])),
        ].join("\n"),
      };
    case "railway":
      return {
        permissions: read,
        env: "",
        steps: [
          step("Install Railway CLI", ["npm install -g @railway/cli"]),
          step("Deploy to Railway", ['railway up --ci --service "$RAILWAY_SERVICE_ID"'], envBlock(["RAILWAY_TOKEN", "RAILWAY_SERVICE_ID"])),
        ].join("\n"),
      };
    case "render":
      return {
        permissions: read,
        env: "",
        steps: step("Deploy to Render", ['SHA="$GITHUB_SHA"', ...RENDER_SCRIPT], envBlock(["RENDER_API_KEY", "RENDER_SERVICE_ID"])),
      };
    case "vercel":
      if (!vercelSupported(config)) {
        return { permissions: read, env: "", steps: step("Vercel is not supported for this stack", [vercelUnsupportedLine(config)]) };
      }
      return {
        permissions: read,
        env: `    env:\n      VERCEL_ORG_ID: ${sec("VERCEL_ORG_ID")}\n      VERCEL_PROJECT_ID: ${sec("VERCEL_PROJECT_ID")}\n`,
        steps: [
          step("Install Vercel CLI", ["npm install -g vercel@latest"]),
          step("Deploy to Vercel", [
            'vercel pull --yes --environment=production --token="$VERCEL_TOKEN"',
            'vercel build --prod --token="$VERCEL_TOKEN"',
            'vercel deploy --prebuilt --prod --token="$VERCEL_TOKEN"',
          ], envBlock(["VERCEL_TOKEN"])),
        ].join("\n"),
      };
    case "aws":
      return {
        permissions: `${read}\n      id-token: write # OIDC for AWS_ROLE_ARN`,
        env: `    env:\n      AWS_REGION: ${config.region}\n`,
        steps: `      - name: Configure AWS credentials
        # Uses OIDC when AWS_ROLE_ARN is set, otherwise the access-key pair.
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-region: \${{ env.AWS_REGION }}
          role-to-assume: ${sec("AWS_ROLE_ARN")}
          aws-access-key-id: ${sec("AWS_ACCESS_KEY_ID")}
          aws-secret-access-key: ${sec("AWS_SECRET_ACCESS_KEY")}
      - name: Log in to Amazon ECR
        id: ecr
        uses: aws-actions/amazon-ecr-login@v2
${step("Build and push image to ECR", [
  `aws ecr describe-repositories --repository-names ${name} >/dev/null 2>&1 || aws ecr create-repository --repository-name ${name} >/dev/null`,
  `IMAGE="\${{ steps.ecr.outputs.registry }}/${name}:$GITHUB_SHA"`,
  'docker build -t "$IMAGE" .',
  'docker push "$IMAGE"',
  'echo "image=$IMAGE" >> "$GITHUB_OUTPUT"',
], "        id: image\n")}
${step("Resolve account id in task definition", [
  "export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)",
  "envsubst '$AWS_ACCOUNT_ID' < deploy/aws/task-definition.json > task-definition.json",
])}
      - name: Render task definition
        id: taskdef
        uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          task-definition: task-definition.json
          container-name: api
          image: \${{ steps.image.outputs.image }}
      - name: Deploy to ECS
        uses: aws-actions/amazon-ecs-deploy-task-definition@v2
        with:
          task-definition: \${{ steps.taskdef.outputs.task-definition }}
          cluster: ${name}
          service: ${name}
          desired-count: ${config.replicas}
          wait-for-service-stability: true`,
      };
    case "gcp": {
      const gr = providerRegion(config, "gcp");
      return {
        permissions: read,
        env: `    env:\n      GCP_REGION: ${gr}\n`,
        steps: `      - name: Authenticate to Google Cloud
        id: auth
        # Workload identity: swap credentials_json for workload_identity_provider + service_account.
        uses: google-github-actions/auth@v2
        with:
          credentials_json: ${sec("GCP_SA_KEY")}
      - uses: google-github-actions/setup-gcloud@v2
${step("Build and push image to Artifact Registry", [
  `gcloud artifacts repositories describe ${name} --location "$GCP_REGION" >/dev/null 2>&1 || gcloud artifacts repositories create ${name} --repository-format=docker --location "$GCP_REGION"`,
  'gcloud auth configure-docker "$GCP_REGION-docker.pkg.dev" --quiet',
  `IMAGE="$GCP_REGION-docker.pkg.dev/$GCP_PROJECT_ID/${name}/${name}:$GITHUB_SHA"`,
  'docker build -t "$IMAGE" .',
  'docker push "$IMAGE"',
  `envsubst '$GCP_PROJECT_ID' < deploy/gcp/service.yaml | sed "s|/${name}:latest|/${name}:$GITHUB_SHA|" > service.yaml`,
], `        env:\n          GCP_PROJECT_ID: \${{ steps.auth.outputs.project_id }}\n`)}
      - name: Deploy to Cloud Run
        uses: google-github-actions/deploy-cloudrun@v2
        with:
          metadata: service.yaml
          region: \${{ env.GCP_REGION }}`,
      };
    }
    case "azure": {
      const acr = acrName(name);
      return {
        permissions: read,
        env: "",
        steps: `      - name: Azure login
        uses: azure/login@v2
        with:
          creds: ${sec("AZURE_CREDENTIALS")}
${step("Build and push image to ACR", [
  `az acr login --name ${acr}`,
  `docker build -t ${acr}.azurecr.io/${name}:$GITHUB_SHA .`,
  `docker push ${acr}.azurecr.io/${name}:$GITHUB_SHA`,
])}
      - name: Deploy to Container Apps
        uses: azure/container-apps-deploy-action@v2
        with:
          containerAppName: ${name}
          resourceGroup: ${name}-rg
          imageToDeploy: ${acr}.azurecr.io/${name}:\${{ github.sha }}
${step("Apply scale", [
  `az containerapp update --name ${name} --resource-group ${name}-rg --min-replicas ${minInstances(config)} --max-replicas ${maxInstances(config)}`,
])}`,
      };
    }
    case "k8s":
      return {
        permissions: `${read}\n      packages: write`,
        env: "",
        steps: `      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}
${step("Build and push image", [
  `IMAGE="ghcr.io/\${GITHUB_REPOSITORY_OWNER,,}/${name}:$GITHUB_SHA"`,
  'docker build -t "$IMAGE" .',
  'docker push "$IMAGE"',
  'echo "IMAGE=$IMAGE" >> "$GITHUB_ENV"',
])}
${config.helm && !config.kubernetes ? "      - uses: azure/setup-helm@v4\n" : ""}${step("Deploy to Kubernetes", [
  'printf \'%s\' "$KUBECONFIG_DATA" > "$RUNNER_TEMP/kubeconfig"',
  'export KUBECONFIG="$RUNNER_TEMP/kubeconfig"',
  'SHA="$GITHUB_SHA"',
  ...k8sRollout(config),
], `        env:\n          KUBECONFIG_DATA: ${sec("KUBECONFIG")}\n          K8S_SECRETS_ENV: ${sec("K8S_SECRETS_ENV")}\n`)}`,
      };
  }
}

// `testSteps` is the language build/test step list shared with ci.yml.
export function githubDeployWorkflow(config: StackConfig, testSteps: string): string {
  const t = deployTarget(config);
  const d = ghaDeploySteps(config);
  return `# Deploys to ${LABEL[t]} on every push to main (after tests pass) and on manual dispatch.
# Required secrets: ${DEPLOY_SECRETS[t].map((s) => s.name).join(", ")} — see DEPLOY.md.
name: deploy
on:
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: deploy
  cancel-in-progress: false

jobs:
  # Same build/test steps as ci.yml, so every deploy is gated on green tests
  # (also for manual dispatches). ponytail: costs one duplicate test run per push to main.
  test:
    runs-on: ubuntu-latest
    steps:
${testSteps}

  deploy:
    name: Deploy to ${LABEL[t]}
    needs: test
    runs-on: ubuntu-latest
    permissions:
${d.permissions}
${d.env}    steps:
      - uses: actions/checkout@v4
${d.steps}
`;
}

// ─── GitLab CI / CircleCI ────────────────────────────────────────────────────

const needsDocker = (c: StackConfig) => deployTarget(c) === "aws" || deployTarget(c) === "k8s";

function gitlabImage(config: StackConfig): { image: string; setup: string[] } {
  switch (deployTarget(config)) {
    case "aws":
      return { image: "docker:27", setup: ["apk add --no-cache aws-cli jq"] };
    case "k8s":
      return {
        image: "docker:27",
        setup: [
          "apk add --no-cache curl helm",
          "curl -fsSLo /usr/local/bin/kubectl https://dl.k8s.io/release/v1.31.0/bin/linux/amd64/kubectl && chmod +x /usr/local/bin/kubectl",
          'echo "$CI_REGISTRY_PASSWORD" | docker login -u "$CI_REGISTRY_USER" --password-stdin "$CI_REGISTRY"',
        ],
      };
    case "gcp":
      return { image: "google/cloud-sdk:slim", setup: ["apt-get update -qq && apt-get install -y -qq jq"] };
    case "azure":
      return { image: "mcr.microsoft.com/azure-cli:latest", setup: ["command -v jq >/dev/null || tdnf install -y jq"] };
    case "render":
      return { image: "alpine:3.20", setup: ["apk add --no-cache curl jq"] };
    default:
      return { image: "node:22", setup: [] };
  }
}

export function gitlabDeployJob(config: StackConfig): string {
  const t = deployTarget(config);
  const { image, setup } = gitlabImage(config);
  const docker = needsDocker(config);
  const lines = ['SHA="$CI_COMMIT_SHA"', ...(t === "k8s" ? ['REGISTRY_IMAGE="$CI_REGISTRY_IMAGE"'] : []), ...setup, ...shellDeployScript(config)];
  return `

# Deploys to ${LABEL[t]} on the default branch. Set these as masked CI/CD variables:
#   ${DEPLOY_SECRETS[t].map((s) => s.name).join(", ")}
deploy:
  stage: deploy
  image: ${image}${docker ? `\n  services: [docker:27-dind]\n  variables:\n    DOCKER_TLS_CERTDIR: "/certs"` : ""}
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  script:
    - |
      set -e
${lines.map((l) => `      ${l}`).join("\n")}`;
}

function circleSetup(config: StackConfig): string[] {
  switch (deployTarget(config)) {
    case "aws":
      return ['curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscli.zip', "unzip -q /tmp/awscli.zip -d /tmp && sudo /tmp/aws/install"];
    case "k8s":
      return [
        "curl -fsSLo /tmp/kubectl https://dl.k8s.io/release/v1.31.0/bin/linux/amd64/kubectl && sudo install /tmp/kubectl /usr/local/bin/kubectl",
        "curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash",
        'echo "$REGISTRY_TOKEN" | docker login ghcr.io -u "$REGISTRY_USER" --password-stdin',
      ];
    case "gcp":
      return [
        "curl -fsSL https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz | tar -xz -C $HOME",
        'echo \'export PATH="$HOME/google-cloud-sdk/bin:$PATH"\' >> "$BASH_ENV"',
        'export PATH="$HOME/google-cloud-sdk/bin:$PATH"',
      ];
    case "azure":
      return ["curl -fsSL https://aka.ms/InstallAzureCLIDeb | sudo bash"];
    default:
      return []; // cimg/node already has curl, jq and npm
  }
}

export function circleDeployJob(config: StackConfig): { job: string; workflow: string } {
  const t = deployTarget(config);
  const image = `ghcr.io/${lowerOwner(config)}/${safeName(config.name)}`;
  const lines = ['SHA="$CIRCLE_SHA1"', ...(t === "k8s" ? [`REGISTRY_IMAGE="${image}"`] : []), ...circleSetup(config), ...shellDeployScript(config)];
  const job = `
  # Deploys to ${LABEL[t]}. Set in a CircleCI context / project env: ${DEPLOY_SECRETS[t].map((s) => s.name).join(", ")}${t === "k8s" ? ", REGISTRY_USER, REGISTRY_TOKEN" : ""}
  deploy:
    docker:
      - image: cimg/node:lts
    steps:
      - checkout${needsDocker(config) ? "\n      - setup_remote_docker" : ""}
      - run:
          name: Deploy to ${LABEL[t]}
          command: |
            set -eu
${lines.map((l) => `            ${l}`).join("\n")}`;
  const workflow = `
      - deploy:
          requires: [test]
          filters:
            branches:
              only: main`;
  return { job, workflow };
}

// ─── Provider config files ───────────────────────────────────────────────────

export function flyToml(config: StackConfig): string {
  const name = safeName(config.name);
  const grpc = config.api === "grpc";
  const jvm = config.language === "java" || config.language === "kotlin";
  const scaleToZero = config.autoscale || config.scaling === "serverless";
  return `# Fly.io app config, read by \`flyctl deploy\` (CI: the deploy job).
app = "${name}"
primary_region = "${providerRegion(config, "fly")}"

[build]
  dockerfile = "Dockerfile"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "${scaleToZero ? "stop" : "off"}"
  auto_start_machines = true
  min_machines_running = ${minInstances(config)}
${grpc ? `  [http_service.http_options]
    h2_backend = true
` : `
[[http_service.checks]]
  grace_period = "${jvm ? "60s" : "15s"}"
  interval = "15s"
  method = "GET"
  path = "/health"
  timeout = "5s"
`}
[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory = "${jvm ? "1gb" : "512mb"}"
`;
}

export function railwayJson(config: StackConfig): string {
  const deploy: Record<string, unknown> = { numReplicas: Math.max(config.replicas, 1), restartPolicyType: "ON_FAILURE" };
  if (config.api !== "grpc") deploy.healthcheckPath = "/health";
  return JSON.stringify({ $schema: "https://railway.com/railway.schema.json", build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" }, deploy }, null, 2) + "\n";
}

// ─── DEPLOY.md section ───────────────────────────────────────────────────────

export function ciDeploySection(config: StackConfig): string {
  const t = deployTarget(config);
  const name = safeName(config.name);
  const where =
    config.cicd === "gitlab-ci" ? "the `deploy` job in `.gitlab-ci.yml`"
    : config.cicd === "circleci" ? "the `deploy` job in `.circleci/config.yml`"
    : "`.github/workflows/deploy.yml` (workflow `deploy`, job `deploy`)";
  const prereq: Record<Deployment, string[]> = {
    fly: [`Create the app once: \`flyctl apps create ${name}\`. \`fly.toml\` is committed; CI runs \`flyctl deploy\` and scales to ${flyCount(config)} machine(s).`],
    railway: ["Create a Railway project + service; `railway.json` sets the Dockerfile builder, replicas and health check."],
    render: ["Create a Docker web service linked to this repo and set its **Auto-Deploy** to *Off* — CI triggers each deploy (for the pushed commit) and waits for it to go live."],
    vercel: vercelSupported(config)
      ? ["Run `vercel link` once to create the project; CI runs `vercel pull` → `vercel build --prod` → `vercel deploy --prebuilt --prod`. Long-running work (queue consumers, WebSockets) will not run on Vercel's serverless functions."]
      : [`**This stack can't run on Vercel** (${config.language}/${config.framework}${config.api === "grpc" ? ", gRPC" : ""}): Vercel only runs serverless Node frameworks and FastAPI, not a Dockerfile. The deploy job fails fast with that message — switch the deployment target to Railway, Render, Fly or a container platform.`],
    aws: [
      `Create once (see above): ECS cluster \`${name}\` + Fargate service \`${name}\`, log group \`/ecs/${name}\`, \`ecsTaskExecutionRole\`, and the SSM parameters. CI creates the ECR repo if missing.`,
      "Credentials: `AWS_ROLE_ARN` (GitHub OIDC trust for this repo) **or** `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`. Needs ECR push, `ecs:RegisterTaskDefinition`, `ecs:UpdateService`, `ecs:Describe*`, `iam:PassRole` on the execution role.",
      `Region is \`${config.region}\` (baked into the task definition), not a secret.`,
    ],
    gcp: [
      "Enable `run`, `artifactregistry` and `cloudbuild` APIs and create the Secret Manager secrets above. CI creates the Artifact Registry repo if missing and deploys `deploy/gcp/service.yaml` with the commit's image.",
      "The first deploy is private; grant `roles/run.invoker` to `allUsers` once if the API is public.",
    ],
    azure: [
      `Create the resource group, ACR, environment and the Container App once (steps 1–4 above). CI builds + pushes \`${acrName(name)}.azurecr.io/${name}:<sha>\` and updates the existing app's image and scale (keeps its secrets).`,
      "The service principal needs `Contributor` on the resource group and `AcrPush` on the registry.",
    ],
    k8s: [
      config.cicd === "argo"
        ? "Argo CD syncs the cluster from git; CI only builds and pushes the image. Bump the tag in git (or run Argo CD Image Updater) to roll out."
        : `CI pushes \`ghcr.io/<owner>/${name}:<sha>\`, then ${config.kubernetes || !config.helm ? "applies `deploy/k8s/` with that image" : "runs `helm upgrade --install` with `image.tag=<sha>`"} and waits for the rollout.`,
      "GHCR packages are private by default — make the package public or add an `imagePullSecret` to the namespace.",
      `\`K8S_SECRETS_ENV\` (optional) is synced into the \`${name}-env\` Secret the Deployment reads; otherwise create it with \`make -C deploy/k8s secrets\`.`,
    ],
  };
  const rows = DEPLOY_SECRETS[t].map((s) => `| \`${s.name}\` | ${s.required ? "yes" : "see note"} | ${s.description} |`);
  return `
## Continuous deployment

Deploys run from ${where} on every push to \`main\` after tests pass${config.cicd === "gitlab-ci" || config.cicd === "circleci" ? "" : ", and on demand via **Run workflow** (`workflow_dispatch`)"}. Every image is tagged with the git SHA.

| Secret | Required | Value |
| --- | --- | --- |
${rows.join("\n")}
${t === "k8s" && config.cicd === "circleci" ? "| `REGISTRY_USER` / `REGISTRY_TOKEN` | yes | GHCR user + token with `write:packages` |\n" : ""}
${prereq[t].map((p) => `- ${p}`).join("\n")}
`;
}
