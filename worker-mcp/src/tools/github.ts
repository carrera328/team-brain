import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface GitHubConfig {
  token: string;
  defaultRepo: string; // "owner/repo"
}

async function ghFetch(config: GitHubConfig, path: string, options?: RequestInit): Promise<any> {
  const resp = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "team-brain-mcp",
      ...(options?.headers || {}),
    },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`GitHub API ${resp.status}: ${body}`);
  }
  return resp.json();
}

export function registerGitHubTools(server: McpServer, config: GitHubConfig) {
  const repo = config.defaultRepo;

  // -----------------------------------------------------------------------
  // Search issues & PRs
  // -----------------------------------------------------------------------
  server.registerTool(
    "github_search_issues",
    {
      title: "Search GitHub Issues & PRs",
      description:
        `Search issues and pull requests in the ${repo} repo. Use when someone asks about bugs, features, PRs, or work items on GitHub.`,
      inputSchema: {
        query: z.string().describe("Search term — matches title and body"),
        state: z.enum(["open", "closed", "all"]).optional().describe("Filter by state (default: open)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, state }) => {
      try {
        const q = `${query} repo:${repo} ${state && state !== "all" ? `state:${state}` : ""}`.trim();
        const data = await ghFetch(config, `/search/issues?q=${encodeURIComponent(q)}&per_page=10`);
        const items = (data.items || []).map((i: any) => ({
          number: i.number,
          title: i.title,
          state: i.state,
          type: i.pull_request ? "PR" : "Issue",
          author: i.user?.login,
          created: i.created_at,
          labels: i.labels?.map((l: any) => l.name),
          url: i.html_url,
        }));

        if (items.length === 0) {
          return { content: [{ type: "text" as const, text: `No GitHub issues/PRs found for "${query}".` }] };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(items, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `GitHub search error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Get issue/PR details
  // -----------------------------------------------------------------------
  server.registerTool(
    "github_get_issue",
    {
      title: "Get GitHub Issue or PR",
      description:
        `Get full details for a specific issue or PR by number in ${repo}.`,
      inputSchema: {
        number: z.number().describe("Issue or PR number"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ number }) => {
      try {
        const issue = await ghFetch(config, `/repos/${repo}/issues/${number}`);
        const result: any = {
          number: issue.number,
          title: issue.title,
          state: issue.state,
          type: issue.pull_request ? "PR" : "Issue",
          author: issue.user?.login,
          created: issue.created_at,
          updated: issue.updated_at,
          labels: issue.labels?.map((l: any) => l.name),
          assignees: issue.assignees?.map((a: any) => a.login),
          body: issue.body,
          url: issue.html_url,
        };

        // If it's a PR, get extra details
        if (issue.pull_request) {
          //const pr = await ghFetch(config, `/repos/${repo}/pulls/${number}`);
          const [pr, reviews, files] = await Promise.all([
            ghFetch(config, `/repos/${repo}/pulls/${number}`),
            ghFetch(config, `/repos/${repo}/pulls/${number}/reviews`),
            ghFetch(config, `/repos/${repo}/pulls/${number}/files`),
          ]);
          
          result.mergeable = pr.mergeable;
          result.merged = pr.merged;
          result.base = pr.base?.ref;
          result.head = pr.head?.ref;
          result.additions = pr.additions;
          result.deletions = pr.deletions;
          result.changed_files = pr.changed_files;
          
          // Requested reviewers 
          result.requested_reviewers = pr.requested_reviewers?.map((r: any) => r.login);
         // Review status — latest decision per reviewer
          const latestByUser = Object.values(
            reviews.reduce((acc: any, r: any) => {
              acc[r.user?.login] = r;
              return acc;
            }, {})
          );
          result.reviews = latestByUser.map((r: any) => ({
            user: r.user?.login,
            state: r.state,           // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED
            submitted_at: r.submitted_at,
          }));
          // Changes
          result.file_changes = files.map((f: any) => ({
            filename: f.filename,
            status: f.status,   
            additions: f.additions,
            deletions: f.deletions,
            patch: f.patch  
          }));
      }
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `GitHub error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Create issue
  // -----------------------------------------------------------------------
  server.registerTool(
    "github_create_issue",
    {
      title: "Create GitHub Issue",
      description:
        `Create a new issue in ${repo}. Use when someone wants to file a bug, feature request, or task.`,
      inputSchema: {
        title: z.string().describe("Issue title"),
        body: z.string().optional().describe("Issue description (supports markdown)"),
        labels: z.array(z.string()).optional().describe("Labels to apply"),
        assignees: z.array(z.string()).optional().describe("GitHub usernames to assign"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ title, body, labels, assignees }) => {
      try {
        const data = await ghFetch(config, `/repos/${repo}/issues`, {
          method: "POST",
          body: JSON.stringify({ title, body, labels, assignees }),
        });
        return {
          content: [{
            type: "text" as const,
            text: `Issue #${data.number} created: "${data.title}"\n${data.html_url}`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `GitHub create error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Get PR file changes & diffs
  // -----------------------------------------------------------------------
  server.registerTool(
    "github_get_pr_files",
    {
      title: "Get PR File Changes & Diffs",
      description:
        `Get the actual file changes (diffs) for a pull request in ${repo}. Use when someone wants to see what code changed in a PR, review changes, or understand what a PR does.`,
      inputSchema: {
        number: z.number().describe("PR number"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ number }) => {
      try {
        const files = await ghFetch(config, `/repos/${repo}/pulls/${number}/files?per_page=30`);
        const result = files.map((f: any) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch || "(binary or too large)",
        }));

        if (result.length === 0) {
          return { content: [{ type: "text" as const, text: "No files changed in this PR." }] };
        }

        // Format nicely
        let output = `## PR #${number} — Changed Files\n\n`;
        for (const f of result) {
          output += `### ${f.status === "added" ? "🟢" : f.status === "removed" ? "🔴" : "🟡"} ${f.filename} (${f.status})\n`;
          output += `+${f.additions} -${f.deletions}\n`;
          if (f.patch && f.patch !== "(binary or too large)") {
            output += `\`\`\`diff\n${f.patch}\n\`\`\`\n`;
          }
          output += "\n";
        }

        return { content: [{ type: "text" as const, text: output }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `GitHub PR files error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // List open PRs
  // -----------------------------------------------------------------------
  server.registerTool(
    "github_list_prs",
    {
      title: "List GitHub Pull Requests",
      description:
        `List pull requests in ${repo}. Use when someone asks about open PRs or code reviews.`,
      inputSchema: {
        state: z.enum(["open", "closed", "all"]).optional().describe("PR state (default: open)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ state }) => {
      try {
        const data = await ghFetch(config, `/repos/${repo}/pulls?state=${state || "open"}&per_page=15`);
        const prs = data.map((pr: any) => ({
          number: pr.number,
          title: pr.title,
          state: pr.state,
          author: pr.user?.login,
          branch: pr.head?.ref,
          base: pr.base?.ref,
          created: pr.created_at,
          draft: pr.draft,
          url: pr.html_url,
        }));

        if (prs.length === 0) {
          return { content: [{ type: "text" as const, text: `No ${state || "open"} PRs found.` }] };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(prs, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `GitHub PR error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // List recent commits
  // -----------------------------------------------------------------------
  server.registerTool(
    "github_list_commits",
    {
      title: "List Recent Commits",
      description:
        `List recent commits in ${repo}. Use when someone asks what's been pushed or who committed recently.`,
      inputSchema: {
        branch: z.string().optional().describe("Branch name (default: main)"),
        limit: z.number().optional().describe("Max commits (default 10)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ branch, limit }) => {
      try {
        const ref = branch || "main";
        const max = limit || 10;
        const data = await ghFetch(config, `/repos/${repo}/commits?sha=${ref}&per_page=${max}`);
        const commits = data.map((c: any) => ({
          sha: c.sha?.substring(0, 7),
          message: c.commit?.message?.split("\n")[0],
          author: c.commit?.author?.name,
          date: c.commit?.author?.date,
          url: c.html_url,
        }));
        return { content: [{ type: "text" as const, text: JSON.stringify(commits, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `GitHub commits error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Get file contents
  // -----------------------------------------------------------------------
  server.registerTool(
    "github_get_file",
    {
      title: "Get File from GitHub",
      description:
        `Read a file from ${repo}. Use when someone asks to see code, configs, or any file in the repo.`,
      inputSchema: {
        path: z.string().describe("File path, e.g. 'README.md' or 'force-app/main/default/classes/MyClass.cls'"),
        branch: z.string().optional().describe("Branch (default: main)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ path, branch }) => {
      try {
        const ref = branch || "main";
        const data = await ghFetch(config, `/repos/${repo}/contents/${path}?ref=${ref}`);
        if (data.type !== "file") {
          // It's a directory — list contents
          const items = Array.isArray(data) ? data : [data];
          const listing = items.map((i: any) => `${i.type === "dir" ? "📁" : "📄"} ${i.name}`).join("\n");
          return { content: [{ type: "text" as const, text: listing }] };
        }
        const content = atob(data.content);
        return { content: [{ type: "text" as const, text: `File: ${path}\n\n${content}` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `GitHub file error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Create or update a file
  // -----------------------------------------------------------------------
  server.registerTool(
    "github_update_file",
    {
      title: "Create New Tool File on GitHub",
      description:
        `Create a new tool file in worker-mcp/src/tools/ in ${repo}. Only creates NEW files — cannot overwrite existing files. The file must use the McpServer.registerTool pattern (import McpServer from "@modelcontextprotocol/sdk/server/mcp.js" and export a register function). After creating the tool file, you must ALSO update worker-mcp/src/index.ts to import and register it — but ONLY by adding lines, never rewriting the file.`,
      inputSchema: {
        path: z.string().describe("File path — must be under worker-mcp/src/tools/, e.g. 'worker-mcp/src/tools/hello.ts'"),
        content: z.string().describe("The full file content to write"),
        message: z.string().describe("Commit message"),
        branch: z.string().optional().describe("Branch to commit to (default: master)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ path, content, message, branch }) => {
      try {
        // Guard: only allow writes under worker-mcp/src/tools/
        if (!path.startsWith("worker-mcp/src/tools/")) {
          return {
            content: [{
              type: "text" as const,
              text: `Blocked: can only create files under worker-mcp/src/tools/. Got: ${path}`,
            }],
          };
        }

        const ref = branch || "master";

        // Guard: block overwrites of existing files
        try {
          await ghFetch(config, `/repos/${repo}/contents/${path}?ref=${ref}`);
          return {
            content: [{
              type: "text" as const,
              text: `Blocked: ${path} already exists. This tool can only create new files, not overwrite existing ones.`,
            }],
          };
        } catch {
          // File doesn't exist — good, proceed with creation
        }

        // Base64 encode the content
        const encoded = btoa(unescape(encodeURIComponent(content)));

        const data = await ghFetch(config, `/repos/${repo}/contents/${path}`, {
          method: "PUT",
          body: JSON.stringify({
            message,
            content: encoded,
            branch: ref,
          }),
        });

        return {
          content: [{
            type: "text" as const,
            text: `Created ${path} on branch ${ref}\nCommit: ${data.commit?.sha?.substring(0, 7)} — ${message}\n${data.content?.html_url}\n\nNote: You still need to register this tool in worker-mcp/src/index.ts for it to be available.`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `GitHub create error: ${e.message}` }] };
      }
    }
  );
}
