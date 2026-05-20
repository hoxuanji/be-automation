import { type NextRequest } from "next/server";
import { getVercelUser, VercelError } from "@/lib/vercel";

export const runtime = "nodejs";

// POST /api/vercel/verify
// Body: { token: string }
// Returns the Vercel user associated with the token so the UI can confirm
// "connected as <username>". Mirrors the shape of /api/railway/verify.
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
      { code: "token_required", error: "Token is required.", hint: "Paste your Vercel Personal Access Token." },
      { status: 400 }
    );
  }

  try {
    const user = await getVercelUser(trimmed);
    return Response.json({ id: user.uid, name: user.name, email: user.email, username: user.username });
  } catch (err) {
    if (err instanceof VercelError) {
      const status = err.code === "not_authorized" ? 401 : err.code === "network_error" ? 503 : 500;
      return Response.json(
        {
          code: err.code,
          error:
            err.code === "not_authorized"
              ? "Vercel rejected this token."
              : err.code === "network_error"
              ? "Couldn't reach Vercel."
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
