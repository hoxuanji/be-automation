import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function GET() {
  const cookieStore = await cookies();
  const token = cookieStore.get("github_token")?.value;

  if (!token) {
    return NextResponse.json({ connected: false });
  }

  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "Helios-App/1.0",
    },
    next: { revalidate: 60 },
  });

  if (!res.ok) {
    cookieStore.delete("github_token");
    return NextResponse.json({ connected: false });
  }

  const user = (await res.json()) as { login: string; avatar_url: string };
  return NextResponse.json({ connected: true, login: user.login, avatar: user.avatar_url });
}

export async function DELETE() {
  const cookieStore = await cookies();
  cookieStore.delete("github_token");
  return NextResponse.json({ ok: true });
}
