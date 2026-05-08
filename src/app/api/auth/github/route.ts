import { NextResponse, type NextRequest } from "next/server";
import crypto from "crypto";

function signState(payload: string): string {
  const secret = process.env.JWT_SECRET ?? "helios-dev-secret-change-in-production";
  return crypto.createHmac("sha256", secret).update(payload).digest("hex").slice(0, 24);
}

export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get("mode") ?? "connect"; // "login" | "connect"
  const nonce = crypto.randomBytes(16).toString("hex");
  const payload = `${nonce}:${mode}`;
  const sig = signState(payload);
  const stateValue = `${payload}:${sig}`;

  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID!,
    scope: "repo,user:email",
    state: stateValue,
  });

  const response = NextResponse.redirect(
    `https://github.com/login/oauth/authorize?${params.toString()}`
  );

  const returnTo = req.nextUrl.searchParams.get("returnTo");
  if (returnTo && returnTo.startsWith("/")) {
    response.cookies.set("github_return_to", returnTo, {
      httpOnly: true,
      path: "/",
      maxAge: 600,
      sameSite: "lax",
    });
  }

  return response;
}
