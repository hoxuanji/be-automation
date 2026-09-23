// Guards for user input interpolated into api.github.com paths. Without them a
// value like "../../user" walks the URL to a different endpoint, called with
// the user's token.

/** Owner / repo names: GitHub's own charset, minus "." and "..". */
export function isGhName(v: string | null | undefined): v is string {
  return !!v && /^[A-Za-z0-9_.-]+$/.test(v) && v !== "." && v !== "..";
}

/** Branch / ref names: same charset plus "/", with no empty, "." or ".." segment. */
export function isGhRef(v: string | null | undefined): v is string {
  return !!v && /^[A-Za-z0-9_.\/-]+$/.test(v) && v.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

/** Repo file path: any chars per segment, but no "." / ".." segment; each segment URL-encoded. */
export function encodeGhPath(v: string): string | null {
  const segs = v.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return null;
  return segs.map(encodeURIComponent).join("/");
}
