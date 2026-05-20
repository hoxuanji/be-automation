import { type NextRequest } from "next/server";
import { listRenderOwners, RenderError } from "@/lib/render";

export const runtime = "nodejs";

// POST /api/render/verify
// Body: { token: string }
// Returns the first owner the API key has access to so the UI can confirm
// "you're connected as <name>". Mirrors the Railway verify shape.
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ code: "invalid_json", error: "Malformed request body." }, { status: 400 });
  }

  const { token } = body as { token?: string };
  const trimmed = typeof token === "string" ? token.trim() : "";
  if (!trimmed) {
    return Response.json(
      { code: "token_required", error: "Token is required.", hint: "Paste your Render Personal API Key." },
      { status: 400 }
    );
  }

  try {
    const owners = await listRenderOwners(trimmed);
    if (owners.length === 0) {
      return Response.json(
        {
          code: "no_owner",
          error: "API key has no associated owner.",
          hint: "Create a Render account at render.com/register and re-issue the API key.",
        },
        { status: 400 }
      );
    }
    const primary = owners.find((o) => o.type === "user") ?? owners[0];
    return Response.json({ id: primary.id, name: primary.name, email: primary.email, type: primary.type });
  } catch (err) {
    if (err instanceof RenderError) {
      const status = err.code === "not_authorized" ? 401 : err.code === "network_error" ? 503 : 500;
      return Response.json(
        {
          code: err.code,
          error:
            err.code === "not_authorized"
              ? "Render rejected this key."
              : err.code === "network_error"
              ? "Couldn't reach Render."
              : "Verification failed.",
          hint: err.message,
        },
        { status }
      );
    }
    return Response.json(
      {
        code: "unexpected",
        error: "Verification failed.",
        hint: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      },
      { status: 500 }
    );
  }
}
