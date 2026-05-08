const RAILWAY_GQL = "https://backboard.railway.app/graphql/v2";

async function gql<T>(
  token: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const res = await fetch(RAILWAY_GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors[0].message);
  if (!json.data) throw new Error("Empty response from Railway API");
  return json.data;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export async function verifyRailwayToken(
  token: string
): Promise<{ id: string; email: string; name: string }> {
  const data = await gql<{ me: { id: string; email: string; name: string } }>(
    token,
    `query { me { id email name } }`
  );
  return data.me;
}

// ─── Workspaces ───────────────────────────────────────────────────────────────

export async function getDefaultWorkspaceId(token: string): Promise<string> {
  // Try top-level workspaces query (current Railway API)
  try {
    const data = await gql<{
      workspaces: { id: string; name: string; isPersonal?: boolean }[];
    }>(token, `query { workspaces { id name isPersonal } }`);
    const ws =
      data.workspaces.find((w) => w.isPersonal) ?? data.workspaces[0];
    if (ws?.id) return ws.id;
  } catch {}

  // Fallback: me.workspaces connection (older schema)
  try {
    const data = await gql<{
      me: { workspaces: { edges: { node: { id: string } }[] } };
    }>(token, `query { me { workspaces { edges { node { id } } } } }`);
    const id = data.me.workspaces.edges[0]?.node.id;
    if (id) return id;
  } catch {}

  throw new Error(
    "Could not find a Railway workspace. Make sure your token has the correct permissions."
  );
}

// ─── Projects ─────────────────────────────────────────────────────────────────

export async function createRailwayProject(
  token: string,
  name: string,
  workspaceId: string
): Promise<{ id: string }> {
  const data = await gql<{ projectCreate: { id: string } }>(
    token,
    `mutation CreateProject($input: ProjectCreateInput!) {
      projectCreate(input: $input) { id }
    }`,
    { input: { name, workspaceId } }
  );
  return data.projectCreate;
}

export async function getRailwayProject(
  token: string,
  id: string
): Promise<{
  environments: { id: string; name: string }[];
  services: { id: string; name: string }[];
}> {
  const data = await gql<{
    project: {
      environments: { edges: { node: { id: string; name: string } }[] };
      services: { edges: { node: { id: string; name: string } }[] };
    };
  }>(
    token,
    `query GetProject($id: String!) {
      project(id: $id) {
        environments { edges { node { id name } } }
        services { edges { node { id name } } }
      }
    }`,
    { id }
  );
  return {
    environments: data.project.environments.edges.map((e) => e.node),
    services: data.project.services.edges.map((e) => e.node),
  };
}

// ─── Services ─────────────────────────────────────────────────────────────────

export async function createRailwayService(
  token: string,
  projectId: string,
  name: string,
  repo: string // "owner/repo-name"
): Promise<{ id: string }> {
  const data = await gql<{ serviceCreate: { id: string } }>(
    token,
    `mutation CreateService($input: ServiceCreateInput!) {
      serviceCreate(input: $input) { id }
    }`,
    { input: { projectId, name, source: { repo } } }
  );
  return data.serviceCreate;
}

// ─── Variables ────────────────────────────────────────────────────────────────

export async function setRailwayVariables(
  token: string,
  projectId: string,
  serviceId: string,
  environmentId: string,
  variables: Record<string, string>
): Promise<void> {
  await gql(
    token,
    `mutation SetVars($input: VariableCollectionUpsertInput!) {
      variableCollectionUpsert(input: $input)
    }`,
    { input: { projectId, serviceId, environmentId, variables } }
  );
}

// ─── Domains ──────────────────────────────────────────────────────────────────

export async function createRailwayDomain(
  token: string,
  serviceId: string,
  environmentId: string
): Promise<string> {
  const data = await gql<{ serviceDomainCreate: { domain: string } }>(
    token,
    `mutation CreateDomain($input: ServiceDomainCreateInput!) {
      serviceDomainCreate(input: $input) { domain }
    }`,
    { input: { serviceId, environmentId } }
  );
  return data.serviceDomainCreate.domain;
}
