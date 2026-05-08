import { Octokit } from "@octokit/rest";
import type { PrProposal, RepoRef } from "./schema";

/**
 * Creates a branch from base, commits all file changes in a single tree,
 * and opens a pull request. Uses the Git Data API so we can land many
 * files in one commit (no mutation storms).
 */
export async function openPullRequest(
  token: string,
  ref: RepoRef,
  baseBranch: string,
  proposal: PrProposal
): Promise<{ number: number; htmlUrl: string }> {
  const octo = new Octokit({ auth: token, userAgent: "helios-autopilot/0.1" });

  // 1. Get base ref SHA
  const { data: baseRef } = await octo.git.getRef({
    owner: ref.owner,
    repo: ref.name,
    ref: `heads/${baseBranch}`,
  });
  const baseSha = baseRef.object.sha;

  // 2. Get the base commit + tree
  const { data: baseCommit } = await octo.git.getCommit({
    owner: ref.owner,
    repo: ref.name,
    commit_sha: baseSha,
  });
  const baseTreeSha = baseCommit.tree.sha;

  // 3. Create a blob for each file change
  const tree = await Promise.all(
    proposal.changes.map(async (c) => {
      const { data: blob } = await octo.git.createBlob({
        owner: ref.owner,
        repo: ref.name,
        content: c.content,
        encoding: "utf-8",
      });
      return {
        path: c.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blob.sha,
      };
    })
  );

  // 4. Create the new tree on top of base tree
  const { data: newTree } = await octo.git.createTree({
    owner: ref.owner,
    repo: ref.name,
    base_tree: baseTreeSha,
    tree,
  });

  // 5. Create commit pointing at new tree
  const { data: newCommit } = await octo.git.createCommit({
    owner: ref.owner,
    repo: ref.name,
    message: proposal.title + "\n\n" + changeSummary(proposal),
    tree: newTree.sha,
    parents: [baseSha],
  });

  // 6. Create (or update) the branch ref
  const branchName = await ensureBranch(
    octo,
    ref,
    proposal.branch,
    newCommit.sha
  );

  // 7. Open the PR
  const { data: pr } = await octo.pulls.create({
    owner: ref.owner,
    repo: ref.name,
    title: proposal.title,
    head: branchName,
    base: baseBranch,
    body: proposal.body + "\n\n---\n_Proposed by [Helios Autopilot](https://github.com/hoxuanji/be-automation)._",
  });

  return { number: pr.number, htmlUrl: pr.html_url };
}

async function ensureBranch(
  octo: Octokit,
  ref: RepoRef,
  desiredName: string,
  commitSha: string
): Promise<string> {
  let name = desiredName;
  let attempt = 0;
  while (attempt < 5) {
    try {
      await octo.git.createRef({
        owner: ref.owner,
        repo: ref.name,
        ref: `refs/heads/${name}`,
        sha: commitSha,
      });
      return name;
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 422) {
        // Branch already exists — bump suffix and retry.
        attempt++;
        name = `${desiredName}-${attempt + 1}`;
        continue;
      }
      throw err;
    }
  }
  throw new Error("Could not create a unique branch after 5 attempts.");
}

function changeSummary(proposal: PrProposal) {
  return proposal.changes
    .map((c) => `- ${c.action === "create" ? "add" : "update"} ${c.path}: ${c.summary}`)
    .join("\n");
}

/** Fetch raw file contents verbatim (for feeding into the proposer). */
export async function fetchFileContent(
  token: string,
  ref: RepoRef,
  path: string,
  branch: string
): Promise<string | null> {
  const octo = new Octokit({ auth: token, userAgent: "helios-autopilot/0.1" });
  try {
    const { data } = await octo.repos.getContent({
      owner: ref.owner,
      repo: ref.name,
      path,
      ref: branch,
    });
    if (Array.isArray(data)) return null;
    if (data.type !== "file" || !("content" in data)) return null;
    return Buffer.from(data.content, "base64").toString("utf-8");
  } catch {
    return null;
  }
}
