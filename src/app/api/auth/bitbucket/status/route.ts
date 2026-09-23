import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function GET() {
  const cookieStore = await cookies();
  const token = cookieStore.get("bitbucket_token")?.value;

  if (!token) {
    return NextResponse.json({ connected: false });
  }

  const res = await fetch("https://api.bitbucket.org/2.0/user", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    next: { revalidate: 60 },
  });

  if (!res.ok) {
    cookieStore.delete("bitbucket_token");
    return NextResponse.json({ connected: false });
  }

  const user = (await res.json()) as { nickname?: string; display_name?: string; links?: { avatar?: { href?: string } } };
  return NextResponse.json({
    connected: true,
    login: user.nickname ?? user.display_name ?? "user",
    avatar: user.links?.avatar?.href ?? null,
  });
}

export async function DELETE() {
  const cookieStore = await cookies();
  cookieStore.delete("bitbucket_token");
  return NextResponse.json({ ok: true });
}
