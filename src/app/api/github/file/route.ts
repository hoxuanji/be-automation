import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";

// GET /api/github/file?owner=&repo=&path=&ref=
// Returns decoded file content from a GitHub repo
export async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const token = cookieStore.get("github_token")?.value;
  if (!token) return NextResponse.json({ error: "no_token" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");
  const path = searchParams.get("path");
  const ref = searchParams.get("ref");

  if (!owner || !repo || !path) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }

  const url = ref
    ? `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`
    : `/repos/${owner}/${repo}/contents/${path}`;

  const res = await fetch(`https://api.github.com${url}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Helios-App/1.0",
    },
  });

  if (!res.ok) {
    return NextResponse.json(
      { error: "file_not_found", status: res.status },
      { status: res.status < 500 ? res.status : 502 }
    );
  }

  const data = (await res.json()) as {
    content: string;
    encoding: string;
    sha: string;
    size: number;
    type: string;
  };

  if (data.type !== "file") {
    return NextResponse.json({ error: "not_a_file" }, { status: 400 });
  }

  // GitHub returns base64 with newlines — strip them before decoding
  const content = data.encoding === "base64"
    ? Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8")
    : data.content;

  return NextResponse.json({ content, sha: data.sha, size: data.size });
}
