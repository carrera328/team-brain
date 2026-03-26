import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

async function jiraFetch(config: JiraConfig, path: string, options?: RequestInit) {
  const auth = btoa(`${config.email}:${config.apiToken}`);
  const resp = await fetch(`${config.baseUrl}/rest/api/3${path}`, {
    ...options,
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options?.headers || {}),
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Jira API ${resp.status}: ${body}`);
  }
  return resp.json();
}

// Extract plain text from Jira's ADF (Atlassian Document Format)
function adfToText(adf: any): string {
  if (!adf || !adf.content) return "";
  const extract = (node: any): string => {
    if (node.type === "text") return node.text || "";
    if (node.content) return node.content.map(extract).join("");
    return "";
  };
  return adf.content.map(extract).join("\n").trim();
}

export function registerJiraTools(server: McpServer, config: JiraConfig) {
  // -----------------------------------------------------------------------
  // Search issues (JQL)
  // -----------------------------------------------------------------------
  server.registerTool(
    "jira_search",
    {
      title: "Search Jira Issues",
      description:
        "Search Jira issues using JQL or plain text. Returns key, summary, status, assignee, and priority. Use JQL for precise queries or plain text for fuzzy search.",
      inputSchema: {
        query: z
          .string()
          .describe(
            'JQL query or plain text. Examples: "status = Done", "sprint in openSprints()", "assignee = currentUser()", or just "login bug"'
          ),
        maxResults: z
          .number()
          .default(10)
          .describe("Max results to return (default 10)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, maxResults }) => {
      try {
        // Try as JQL first; if it fails, wrap in text search
        let jql = query;
        const isPlainText = !/[=~!<>]/.test(query) && !query.includes("(");
        if (isPlainText) {
          jql = `text ~ "${query}" ORDER BY updated DESC`;
        }

        const data: any = await jiraFetch(
          config,
          `/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=summary,status,assignee,priority,issuetype,updated`
        );

        if (!data.issues || data.issues.length === 0) {
          return { content: [{ type: "text" as const, text: "No Jira issues found." }] };
        }

        const results = data.issues.map((issue: any) => ({
          key: issue.key,
          summary: issue.fields.summary,
          status: issue.fields.status?.name,
          assignee: issue.fields.assignee?.displayName || "Unassigned",
          priority: issue.fields.priority?.name,
          type: issue.fields.issuetype?.name,
          updated: issue.fields.updated,
          url: `${config.baseUrl}/browse/${issue.key}`,
        }));

        return {
          content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Jira search error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Get issue details
  // -----------------------------------------------------------------------
  server.registerTool(
    "jira_get_issue",
    {
      title: "Get Jira Issue Details",
      description:
        "Get full details for a specific Jira issue by key (e.g. SCRUM-42). Returns description, comments, status, assignee, etc.",
      inputSchema: {
        issueKey: z.string().describe('The Jira issue key, e.g. "SCRUM-42"'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ issueKey }) => {
      try {
        const data: any = await jiraFetch(
          config,
          `/issue/${issueKey}?fields=summary,description,status,assignee,priority,issuetype,comment,labels,created,updated`
        );

        const comments = (data.fields.comment?.comments || []).slice(-5).map((c: any) => ({
          author: c.author?.displayName,
          body: adfToText(c.body),
          created: c.created,
        }));

        const result = {
          key: data.key,
          summary: data.fields.summary,
          description: adfToText(data.fields.description),
          status: data.fields.status?.name,
          assignee: data.fields.assignee?.displayName || "Unassigned",
          priority: data.fields.priority?.name,
          type: data.fields.issuetype?.name,
          labels: data.fields.labels || [],
          created: data.fields.created,
          updated: data.fields.updated,
          recentComments: comments,
          url: `${config.baseUrl}/browse/${data.key}`,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Jira error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Get current sprint
  // -----------------------------------------------------------------------
  server.registerTool(
    "jira_current_sprint",
    {
      title: "Get Current Sprint",
      description:
        "Get all issues in the current active sprint. Shows what the team is working on right now.",
      inputSchema: {
        boardId: z
          .number()
          .default(1)
          .describe("Jira board ID (default 1)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ boardId }) => {
      try {
        // Use agile API for sprint info
        const auth = btoa(`${config.email}:${config.apiToken}`);
        const sprintResp = await fetch(
          `${config.baseUrl}/rest/agile/1.0/board/${boardId}/sprint?state=active`,
          {
            headers: {
              Authorization: `Basic ${auth}`,
              Accept: "application/json",
            },
          }
        );

        if (!sprintResp.ok) {
          // Fall back to JQL
          const data: any = await jiraFetch(
            config,
            `/search/jql?jql=${encodeURIComponent("sprint in openSprints() ORDER BY status ASC, priority DESC")}&maxResults=30&fields=summary,status,assignee,priority,issuetype`
          );

          const results = (data.issues || []).map((issue: any) => ({
            key: issue.key,
            summary: issue.fields.summary,
            status: issue.fields.status?.name,
            assignee: issue.fields.assignee?.displayName || "Unassigned",
            priority: issue.fields.priority?.name,
            type: issue.fields.issuetype?.name,
          }));

          return {
            content: [{ type: "text" as const, text: JSON.stringify({ sprint: "Active Sprint", issues: results }, null, 2) }],
          };
        }

        const sprintData: any = await sprintResp.json();
        const sprint = sprintData.values?.[0];
        if (!sprint) {
          return { content: [{ type: "text" as const, text: "No active sprint found." }] };
        }

        // Get sprint issues
        const issuesResp = await fetch(
          `${config.baseUrl}/rest/agile/1.0/sprint/${sprint.id}/issue?maxResults=30&fields=summary,status,assignee,priority,issuetype`,
          {
            headers: {
              Authorization: `Basic ${auth}`,
              Accept: "application/json",
            },
          }
        );
        const issuesData: any = await issuesResp.json();

        const results = (issuesData.issues || []).map((issue: any) => ({
          key: issue.key,
          summary: issue.fields.summary,
          status: issue.fields.status?.name,
          assignee: issue.fields.assignee?.displayName || "Unassigned",
          priority: issue.fields.priority?.name,
          type: issue.fields.issuetype?.name,
        }));

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              sprint: sprint.name,
              goal: sprint.goal || null,
              startDate: sprint.startDate,
              endDate: sprint.endDate,
              issueCount: results.length,
              issues: results,
            }, null, 2),
          }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Jira sprint error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Add comment to issue
  // -----------------------------------------------------------------------
  server.registerTool(
    "jira_add_comment",
    {
      title: "Add Comment to Jira Issue",
      description: "Add a comment to a Jira issue. Use to log updates, decisions, or context.",
      inputSchema: {
        issueKey: z.string().describe('The Jira issue key, e.g. "SCRUM-42"'),
        comment: z.string().describe("The comment text to add"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ issueKey, comment }) => {
      try {
        await jiraFetch(config, `/issue/${issueKey}/comment`, {
          method: "POST",
          body: JSON.stringify({
            body: {
              version: 1,
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: comment }],
                },
              ],
            },
          }),
        });

        return {
          content: [{ type: "text" as const, text: `Comment added to ${issueKey}.` }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Jira comment error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Create issue
  // -----------------------------------------------------------------------
  server.registerTool(
    "jira_create_issue",
    {
      title: "Create Jira Issue",
      description:
        "Create a new Jira issue (Story, Task, Bug, etc). Use when someone wants to create a ticket, log a bug, or add a story to the backlog.",
      inputSchema: {
        projectKey: z.string().describe("Project key, e.g. 'SCRUM'"),
        summary: z.string().describe("Issue title/summary"),
        issueType: z.enum(["Story", "Task", "Bug", "Epic", "Subtask"]).optional().describe("Issue type (default: Task)"),
        description: z.string().optional().describe("Issue description"),
        priority: z.enum(["Highest", "High", "Medium", "Low", "Lowest"]).optional().describe("Priority level"),
        assignee: z.string().optional().describe("Atlassian account ID to assign to"),
        labels: z.array(z.string()).optional().describe("Labels to apply"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ projectKey, summary, issueType, description, priority, assignee, labels }) => {
      try {
        const fields: any = {
          project: { key: projectKey },
          summary,
          issuetype: { name: issueType || "Task" },
        };

        if (description) {
          fields.description = {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: description }],
              },
            ],
          };
        }

        if (priority) {
          fields.priority = { name: priority };
        }

        if (assignee) {
          fields.assignee = { accountId: assignee };
        }

        if (labels && labels.length > 0) {
          fields.labels = labels;
        }

        const data = await jiraFetch(config, "/issue", {
          method: "POST",
          body: JSON.stringify({ fields }),
        });

        return {
          content: [{
            type: "text" as const,
            text: `✅ Created ${data.key}: "${summary}"\n${config.baseUrl}/browse/${data.key}`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Jira create error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Transition issue (move status)
  // -----------------------------------------------------------------------
  server.registerTool(
    "jira_transition_issue",
    {
      title: "Transition Jira Issue",
      description:
        "Move a Jira issue to a different status (e.g. To Do → In Progress → Done). Use when someone says they started, finished, or want to change the status of a ticket.",
      inputSchema: {
        issueKey: z.string().describe("Issue key, e.g. 'SCRUM-5'"),
        status: z.string().describe("Target status name, e.g. 'In Progress', 'Done', 'To Do'"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ issueKey, status }) => {
      try {
        // Get available transitions
        const transitions = await jiraFetch(config, `/issue/${issueKey}/transitions`);
        const match = transitions.transitions.find(
          (t: any) => t.name.toLowerCase() === status.toLowerCase() || t.to.name.toLowerCase() === status.toLowerCase()
        );

        if (!match) {
          const available = transitions.transitions.map((t: any) => t.to.name).join(", ");
          return {
            content: [{
              type: "text" as const,
              text: `Can't move ${issueKey} to "${status}". Available transitions: ${available}`,
            }],
          };
        }

        await jiraFetch(config, `/issue/${issueKey}/transitions`, {
          method: "POST",
          body: JSON.stringify({ transition: { id: match.id } }),
        });

        return {
          content: [{
            type: "text" as const,
            text: `✅ Moved ${issueKey} to "${match.to.name}"`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Jira transition error: ${e.message}` }] };
      }
    }
  );
  // -----------------------------------------------------------------------
  // Assign an issue
  // -----------------------------------------------------------------------
    server.registerTool(
    "jira_assign_issue",
    {
      title: "Assign Jira Issue",
      description:
        "Assign an existing Jira issue to a user. Accepts an accountId directly, a name/email to search for, or 'me' to assign to the current user.",
      inputSchema: {
        issueKey: z.string().describe("Issue key, e.g. 'SCRUM-42'"),
        assignee: z.string().describe("Either an Atlassian accountId, a name/email to search for, or 'me' to assign to yourself."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ issueKey, assignee }) => {
      try {
        let accountId: string | null;
  
        if (assignee === "me") {
          // Resolve to the authenticated user
          const user = await jiraFetch(config, "/myself");
          accountId = user.accountId;
        } else if (assignee === "none" || assignee === "unassign") {
          // Explicitly unassign
          accountId = null;
        } else if (assignee.includes(":")) {
          // Looks like an accountId already (format: "712020:abc123...")
          accountId = assignee;
        } else {
          // Treat as a name/email and search for the user
          const results = await jiraFetch(config, `/user/search?query=${encodeURIComponent(assignee)}`);
          if (!results.length) {
            return { content: [{ type: "text" as const, text: `No Jira user found matching "${assignee}".` }] };
          }
          if (results.length > 1) {
            const matches = results.map((u: any) => `• ${u.displayName} (${u.emailAddress})`).join("\n");
            return { content: [{ type: "text" as const, text: `Multiple users found, please be more specific:\n${matches}` }] };
          }
          accountId = results[0].accountId;
        }
  
        await jiraFetch(config, `/issue/${issueKey}/assignee`, {
          method: "PUT",
          body: JSON.stringify({ accountId }),
        });
  
        const assigneeLabel = accountId ? `account ${accountId}` : "nobody (unassigned)";
        return {
          content: [{
            type: "text" as const,
            text: `✅ Assigned ${issueKey} to ${assigneeLabel}\n${config.baseUrl}/browse/${issueKey}`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Jira assign error: ${e.message}` }] };
      }
    }
  );
  // -----------------------------------------------------------------------
  // Assign an issue to sprint
  // -----------------------------------------------------------------------
  server.registerTool(
  "jira_add_to_sprint",
  {
    title: "Add Issue to Sprint",
    description:
      "Add an existing Jira issue to a sprint. Can target the active sprint, or a specific sprint by name or number (e.g. 'Sprint 5').",
    inputSchema: {
      issueKey: z.string().describe("Issue key, e.g. 'SCRUM-42'"),
      boardId: z.number().describe("Jira board ID"),
      sprint: z.union([
        z.literal("active"),
        z.string().describe("Sprint name or partial match, e.g. 'Sprint 5'"),
      ]).default("active").describe("Target sprint — 'active' or a sprint name like 'Sprint 5'"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
    async ({ issueKey, boardId, sprint }) => {
      try {
        let targetSprint;
  
        if (sprint === "active") {
          // Fetch only the active sprint
          const data = await jiraFetch(config, `/board/${boardId}/sprint?state=active`, {}, "agile");
          targetSprint = data.values?.[0];
        } else {
          // Search across active + future sprints for a name match
          const [active, future] = await Promise.all([
            jiraFetch(config, `/board/${boardId}/sprint?state=active`, {}, "agile"),
            jiraFetch(config, `/board/${boardId}/sprint?state=future`, {}, "agile"),
          ]);
  
          const allSprints = [...(active.values ?? []), ...(future.values ?? [])];
          targetSprint = allSprints.find((s: any) =>
            s.name.toLowerCase().includes(sprint.toLowerCase())
          );
        }
  
        if (!targetSprint) {
          return { content: [{ type: "text" as const, text: `No sprint found matching "${sprint}" on board ${boardId}.` }] };
        }
  
        await jiraFetch(config, `/sprint/${targetSprint.id}/issue`, {
          method: "POST",
          body: JSON.stringify({ issues: [issueKey] }),
        }, "agile");
  
        return {
          content: [{
            type: "text" as const,
            text: `✅ Added ${issueKey} to sprint "${targetSprint.name}"\n${config.baseUrl}/browse/${issueKey}`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Jira sprint error: ${e.message}` }] };
      }
    }
  );
}
