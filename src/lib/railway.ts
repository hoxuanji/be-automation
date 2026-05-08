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

// ─── Workspace / Team resolution ─────────────────────────────────────────────

export async function getDefaultTeamId(token: string): Promise<string | null> {
  // Try 1: singular 'workspace' field on Query (current Railway API)
  try {
    const data = await gql<{ workspace: { id: string } }>(
      token, `query { workspace { id name } }`
    );
    console.log("[railway] workspace query result:", JSON.stringify(data.workspace));
    if (data.workspace?.id) return data.workspace.id;
  } catch (e) {
    console.warn("[railway] workspace query failed:", e instanceof Error ? e.message : e);
  }

  // Try 2: me.workspaces returns Workspace directly (not a connection)
  try {
    const data = await gql<{ me: { workspaces: { id: string }[] | { id: string } } }>(
      token, `query { me { workspaces { id name } } }`
    );
    console.log("[railway] me.workspaces result:", JSON.stringify(data.me?.workspaces));
    const ws = data.me?.workspaces;
    if (Array.isArray(ws)) return ws[0]?.id ?? null;
    if (ws && typeof ws === "object" && "id" in ws) return (ws as { id: string }).id;
  } catch (e) {
    console.warn("[railway] me.workspaces query failed:", e instanceof Error ? e.message : e);
  }

  return null;
}

// ─── Projects ─────────────────────────────────────────────────────────────────

export async function createRailwayProject(
  token: string,
  name: string,
  teamId: string | null
): Promise<{ id: string }> {
  // Try with teamId (current Railway API)
  if (teamId) {
    try {
      const data = await gql<{ projectCreate: { id: string } }>(
        token,
        `mutation CreateProject($input: ProjectCreateInput!) {
          projectCreate(input: $input) { id }
        }`,
        { input: { name, teamId } }
      );
      return data.projectCreate;
    } catch (e) {
      console.warn("[railway] projectCreate(teamId) failed:", e instanceof Error ? e.message : e);
    }

    // Fallback: older schema used workspaceId
    try {
      const data = await gql<{ projectCreate: { id: string } }>(
        token,
        `mutation CreateProject($input: ProjectCreateInput!) {
          projectCreate(input: $input) { id }
        }`,
        { input: { name, workspaceId: teamId } }
      );
      return data.projectCreate;
    } catch (e) {
      console.warn("[railway] projectCreate(workspaceId) failed:", e instanceof Error ? e.message : e);
    }
  }

  // Last resort: create personal project with no team/workspace ID
  const data = await gql<{ projectCreate: { id: string } }>(
    token,
    `mutation CreateProject($input: ProjectCreateInput!) {
      projectCreate(input: $input) { id }
    }`,
    { input: { name } }
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
