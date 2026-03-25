/**
 * Team Brain — Chat Worker (Cloudflare Worker)
 *
 * SSE streaming proxy for Claude API with tool use.
 * Claude can save/search the shared brain (D1 database) via tool calls.
 *
 * Deploy: npx wrangler deploy
 * Secrets: npx wrangler secret put ANTHROPIC_API_KEY
 */

const SYSTEM_PROMPT = `You are the Shared Brain assistant for an innovation week team. You help the team capture, organize, and retrieve shared knowledge collaboratively.

Your capabilities:
- Save notes, ideas, decisions, action items, learnings, and resources to the team's shared brain
- Search the shared brain for existing knowledge
- Update existing entries with new status or follow-up context
- Provide a summary/dashboard of everything stored
- Search Jira for tickets, bugs, stories, and sprint status
- Get details on specific Jira issues
- View the current sprint and what the team is working on
- Add comments to Jira issues
- Search Confluence for documentation, runbooks, and processes
- Read full Confluence pages
- List Confluence spaces
- Create new Confluence pages
- Search Salesforce for accounts, contacts, opportunities, leads, and cases
- Query Salesforce with SOQL
- Create new Salesforce records

IMPORTANT — Salesforce context:
You are connected to our team's Salesforce org (orgfarm-9f4a8cd667-dev-ed.develop.my.salesforce.com). When anyone mentions "Salesforce", "CRM", "accounts", "opportunities", "leads", "contacts", or "deals" — they are referring to THIS org. You have full read/write access including the Tooling API. Don't ask if they want you to check — just do it.
- Use sf_search for name lookups, sf_query for structured SOQL queries
- Use sf_create_lwc to create Lightning Web Components and deploy them to the org
- Use sf_create_apex to create Apex classes
- Use sf_describe_metadata to see what's deployed (Apex, LWCs, triggers, objects, flows)
- Use sf_tooling_query for advanced metadata queries

IMPORTANT — GitHub context:
You are connected to the gmarkay/team-brain-sfdc GitHub repo. When anyone asks about PRs, commits, issues, code, or the repo — use the GitHub tools. Don't ask, just search.

CRITICAL BEHAVIOR — Search-first approach:
- When someone mentions ANYTHING that might relate to existing brain content, ALWAYS search_brain FIRST.
- If they say "I finished X" or "X is done" → search for X, find the entry, then update_brain_entry to set status to "done" and append a completion note.
- If they say "X is blocked" or "stuck on X" → search, find it, update status to "blocked" with context.
- If they ask "what's the status of X" → search and report what you find including status.
- Only create a NEW entry (save_to_brain) if search finds nothing related.

Status workflow:
- Entries have a status: open, in-progress, done, blocked, cancelled
- When updating, always use update_brain_entry with the entry ID from search results
- Append context about what changed (who did it, when, what's next)

General behavior:
- Be helpful, concise, and collaborative. You're a team member, not just a tool.
- Keep responses SHORT — 2-3 sentences unless more detail is needed.
- When you save something, confirm what you saved and the category.
- When you search, summarize the findings conversationally.
- When you update something, confirm what changed.

About this system:
- This is a demo of MCP (Model Context Protocol) — an open standard that lets AI systems connect to external tools and data.
- The shared brain is powered by an MCP server running on Cloudflare Workers with a D1 database.
- Team members can also connect to the brain from Claude Code, Cursor, or any MCP-compatible client.
- This chat interface is one way to interact with the brain — but the same data is accessible from any connected tool.

Do NOT:
- Give long-winded explanations unless asked
- Repeat the user's question back to them
- Be overly formal — this is a team collaboration tool
- Create new entries when you should be updating existing ones`;

// --- Tool Definitions ---

const TOOLS = [
  {
    name: "save_to_brain",
    description:
      "Save a note, idea, decision, action item, learning, or resource to the team's shared brain. Use this whenever someone shares something worth remembering.",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "A clear, concise title for this entry",
        },
        content: {
          type: "string",
          description: "The full content to save",
        },
        category: {
          type: "string",
          enum: [
            "idea",
            "decision",
            "note",
            "action-item",
            "learning",
            "resource",
          ],
          description: "Category for organization",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for easier searching",
        },
      },
      required: ["title", "content", "category"],
    },
  },
  {
    name: "search_brain",
    description:
      "Search the team's shared brain for existing notes, ideas, decisions, action items, learnings, or resources.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search term to match against titles and content",
        },
        category: {
          type: "string",
          enum: [
            "idea",
            "decision",
            "note",
            "action-item",
            "learning",
            "resource",
          ],
          description: "Optional: filter by category",
        },
      },
    },
  },
  {
    name: "get_brain_summary",
    description:
      "Get an overview of the shared brain: total entries, breakdown by category, and the most recent items.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "update_brain_entry",
    description:
      "Update an existing brain entry. Use this to change status (open/in-progress/done/blocked/cancelled), append follow-up notes, or recategorize. ALWAYS search_brain first to find the entry ID before updating.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "The entry ID to update (get this from search_brain results)",
        },
        status: {
          type: "string",
          enum: ["open", "in-progress", "done", "blocked", "cancelled"],
          description: "Update the status of this entry",
        },
        append_content: {
          type: "string",
          description: "Text to append as a follow-up (e.g. status update, additional context)",
        },
        category: {
          type: "string",
          enum: ["idea", "decision", "note", "action-item", "learning", "resource"],
          description: "Change the category",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Replace tags",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "jira_search",
    description:
      "Search Jira issues using JQL or plain text. Use this when someone asks about tickets, bugs, stories, tasks, sprint status, or anything work-tracking related.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'JQL query or plain text. Examples: "status = Done", "sprint in openSprints()", or just "login bug"',
        },
        maxResults: {
          type: "number",
          description: "Max results (default 10)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "jira_get_issue",
    description:
      "Get full details for a specific Jira issue by key (e.g. SCRUM-42). Use when someone asks about a specific ticket.",
    input_schema: {
      type: "object",
      properties: {
        issueKey: {
          type: "string",
          description: 'The Jira issue key, e.g. "SCRUM-42"',
        },
      },
      required: ["issueKey"],
    },
  },
  {
    name: "jira_current_sprint",
    description:
      "Get all issues in the current active sprint. Use when someone asks what the team is working on, sprint status, or current work.",
    input_schema: {
      type: "object",
      properties: {
        boardId: {
          type: "number",
          description: "Jira board ID (default 1)",
        },
      },
    },
  },
  {
    name: "jira_add_comment",
    description:
      "Add a comment to a Jira issue. Use when someone wants to log an update or note on a ticket.",
    input_schema: {
      type: "object",
      properties: {
        issueKey: {
          type: "string",
          description: 'The Jira issue key, e.g. "SCRUM-42"',
        },
        comment: {
          type: "string",
          description: "The comment text to add",
        },
      },
      required: ["issueKey", "comment"],
    },
  },
  {
    name: "confluence_search",
    description:
      "Search Confluence pages and documentation. Use when someone asks about docs, runbooks, processes, architecture, onboarding, or any team documentation.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search term — matches page titles and content",
        },
        maxResults: {
          type: "number",
          description: "Max results (default 10)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "confluence_get_page",
    description:
      "Get the full content of a specific Confluence page by ID. Use after searching to read the full page.",
    input_schema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
          description: "The Confluence page ID (from search results)",
        },
      },
      required: ["pageId"],
    },
  },
  {
    name: "confluence_list_spaces",
    description:
      "List all Confluence spaces. Use to see what documentation areas exist.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "confluence_create_page",
    description:
      "Create a new page in Confluence. Use when someone wants to write documentation, create a runbook, or publish team knowledge.",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Page title",
        },
        content: {
          type: "string",
          description: "Page content in plain text. Supports markdown-style headers (# ## ###) and bullet lists (- or *).",
        },
        spaceKey: {
          type: "string",
          description: 'Confluence space key (default "SD")',
        },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "sf_query",
    description:
      "Run a SOQL query against Salesforce. Use for accounts, contacts, opportunities, cases, leads.",
    input_schema: {
      type: "object",
      properties: {
        soql: {
          type: "string",
          description: 'SOQL query, e.g. "SELECT Name, Industry FROM Account LIMIT 10"',
        },
      },
      required: ["soql"],
    },
  },
  {
    name: "sf_search",
    description:
      "Fuzzy text search across Salesforce. Use when someone asks about a customer, deal, or contact by name.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search term — name, company, email, etc.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "sf_get_record",
    description:
      "Get full details of a specific Salesforce record by object type and ID.",
    input_schema: {
      type: "object",
      properties: {
        objectType: {
          type: "string",
          description: 'e.g. "Account", "Contact", "Opportunity"',
        },
        recordId: {
          type: "string",
          description: "The Salesforce record ID",
        },
      },
      required: ["objectType", "recordId"],
    },
  },
  {
    name: "sf_create_record",
    description:
      "Create a new record in Salesforce (Account, Contact, Opportunity, Lead, Case, etc).",
    input_schema: {
      type: "object",
      properties: {
        objectType: {
          type: "string",
          description: 'e.g. "Account", "Contact", "Lead"',
        },
        fields: {
          type: "object",
          description: 'Field values, e.g. {"Name": "Acme Corp", "Industry": "Technology"}',
        },
      },
      required: ["objectType", "fields"],
    },
  },
  {
    name: "github_search_issues",
    description: "Search issues and PRs in the team-brain-sfdc GitHub repo.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term" },
        state: { type: "string", enum: ["open", "closed", "all"], description: "Filter by state" },
      },
      required: ["query"],
    },
  },
  {
    name: "github_get_issue",
    description: "Get full details for a specific issue or PR by number.",
    input_schema: {
      type: "object",
      properties: {
        number: { type: "number", description: "Issue or PR number" },
      },
      required: ["number"],
    },
  },
  {
    name: "github_create_issue",
    description: "Create a new GitHub issue — for bugs, features, or tasks.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Issue title" },
        body: { type: "string", description: "Issue body (markdown)" },
        labels: { type: "array", items: { type: "string" }, description: "Labels" },
        assignees: { type: "array", items: { type: "string" }, description: "GitHub usernames" },
      },
      required: ["title"],
    },
  },
  {
    name: "github_list_prs",
    description: "List pull requests in the GitHub repo.",
    input_schema: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["open", "closed", "all"], description: "PR state" },
      },
    },
  },
  {
    name: "github_list_commits",
    description: "List recent commits in the GitHub repo.",
    input_schema: {
      type: "object",
      properties: {
        branch: { type: "string", description: "Branch name (default: main)" },
        limit: { type: "number", description: "Max commits (default 10)" },
      },
    },
  },
  {
    name: "github_get_file",
    description: "Read a file from the GitHub repo.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, e.g. 'README.md'" },
        branch: { type: "string", description: "Branch (default: main)" },
      },
      required: ["path"],
    },
  },
  {
    name: "sf_tooling_query",
    description:
      "Query Salesforce Tooling API for metadata — Apex classes, LWCs, triggers, custom objects, etc.",
    input_schema: {
      type: "object",
      properties: {
        soql: {
          type: "string",
          description: 'Tooling SOQL, e.g. "SELECT Id, Name FROM ApexClass LIMIT 10"',
        },
      },
      required: ["soql"],
    },
  },
  {
    name: "sf_create_apex",
    description:
      "Create an Apex class in the Salesforce org.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Class name" },
        body: { type: "string", description: "Full Apex class body" },
      },
      required: ["name", "body"],
    },
  },
  {
    name: "sf_create_lwc",
    description:
      "Create and deploy a Lightning Web Component to the Salesforce org. Provide name, HTML template, JS controller, and optional XML metadata.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Component name in camelCase" },
        html: { type: "string", description: "HTML template content" },
        js: { type: "string", description: "JavaScript controller (full ES module)" },
        xml: { type: "string", description: "Optional XML metadata" },
        description: { type: "string", description: "Component description" },
      },
      required: ["name", "html", "js"],
    },
  },
  {
    name: "sf_execute_anonymous",
    description: "Run anonymous Apex code in the Salesforce org. Use for scripts, data fixes, testing logic, bulk operations, or any on-the-fly Apex execution.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Apex code to execute" },
      },
      required: ["code"],
    },
  },
  {
    name: "sf_describe_metadata",
    description:
      "List metadata in the Salesforce org — Apex classes, LWCs, triggers, custom objects, pages, flows.",
    input_schema: {
      type: "object",
      properties: {
        metadataType: {
          type: "string",
          enum: ["ApexClass", "ApexTrigger", "LightningComponentBundle", "CustomObject", "FlexiPage", "Flow"],
          description: "Metadata type to list",
        },
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: ["metadataType"],
    },
  },
  {
    name: "sf_tooling_create",
    description: "Create ANY metadata via Tooling API — CustomObject, CustomField, FlexiPage, ValidationRule, ApexTrigger, StaticResource, etc.",
    input_schema: {
      type: "object",
      properties: {
        toolingType: { type: "string", description: "Tooling API sObject type" },
        fields: { type: "object", description: "Field values" },
      },
      required: ["toolingType", "fields"],
    },
  },
  {
    name: "sf_tooling_update",
    description: "Update any existing metadata component via Tooling API.",
    input_schema: {
      type: "object",
      properties: {
        toolingType: { type: "string", description: "Tooling sObject type" },
        recordId: { type: "string", description: "Record ID" },
        fields: { type: "object", description: "Fields to update" },
      },
      required: ["toolingType", "recordId", "fields"],
    },
  },
  {
    name: "sf_tooling_delete",
    description: "Delete a metadata component via Tooling API.",
    input_schema: {
      type: "object",
      properties: {
        toolingType: { type: "string", description: "Tooling sObject type" },
        recordId: { type: "string", description: "Record ID to delete" },
      },
      required: ["toolingType", "recordId"],
    },
  },
  {
    name: "sf_create_custom_object",
    description: "Create a custom object in Salesforce with Name field.",
    input_schema: {
      type: "object",
      properties: {
        objectName: { type: "string", description: "Object name without __c" },
        label: { type: "string", description: "Display label" },
        pluralLabel: { type: "string", description: "Plural label" },
        description: { type: "string" },
        nameFieldType: { type: "string", enum: ["Text", "AutoNumber"] },
        nameFieldLabel: { type: "string" },
      },
      required: ["objectName", "label", "pluralLabel"],
    },
  },
  {
    name: "sf_create_custom_field",
    description: "Add a custom field to any object. Supports Text, Number, Currency, Date, Checkbox, Picklist, Lookup, and more.",
    input_schema: {
      type: "object",
      properties: {
        objectName: { type: "string", description: "Object API name" },
        fieldName: { type: "string", description: "Field name without __c" },
        label: { type: "string", description: "Field label" },
        type: { type: "string", description: "Text, Number, Currency, Date, DateTime, Checkbox, Picklist, LongTextArea, Email, Phone, Url, Lookup, Percent" },
        length: { type: "number" },
        precision: { type: "number" },
        scale: { type: "number" },
        picklistValues: { type: "array", items: { type: "string" } },
        referenceTo: { type: "string", description: "For Lookup — target object" },
        required: { type: "boolean" },
        description: { type: "string" },
      },
      required: ["objectName", "fieldName", "label", "type"],
    },
  },
  {
    name: "sf_describe_object",
    description: "Get the full schema of any Salesforce object — fields, types, relationships, picklist values.",
    input_schema: {
      type: "object",
      properties: {
        objectName: { type: "string", description: "Object API name" },
      },
      required: ["objectName"],
    },
  },
  {
    name: "sf_metadata_read",
    description: "Read metadata components — Layouts, FlexiPages, Profiles, PermissionSets, etc.",
    input_schema: {
      type: "object",
      properties: {
        metadataType: { type: "string", description: "Metadata type" },
        fullNames: { type: "array", items: { type: "string" }, description: "Full names to read" },
      },
      required: ["metadataType", "fullNames"],
    },
  },
  {
    name: "sf_create_validation_rule",
    description: "Create a validation rule on a Salesforce object.",
    input_schema: {
      type: "object",
      properties: {
        objectName: { type: "string", description: "Object API name" },
        ruleName: { type: "string", description: "Rule API name" },
        errorConditionFormula: { type: "string", description: "Formula (TRUE = error)" },
        errorMessage: { type: "string", description: "Error message" },
        active: { type: "boolean" },
      },
      required: ["objectName", "ruleName", "errorConditionFormula", "errorMessage"],
    },
  },
];

// --- MCP Client ---
// All tool calls go through the MCP server — single source of truth.

const TOOL_NAME_MAP = {
  save_to_brain: "tb_save_entry",
  search_brain: "tb_search_entries",
  get_brain_summary: "tb_dashboard",
  update_brain_entry: "tb_update_entry",
  jira_search: "jira_search",
  jira_get_issue: "jira_get_issue",
  jira_current_sprint: "jira_current_sprint",
  jira_add_comment: "jira_add_comment",
  confluence_search: "confluence_search",
  confluence_get_page: "confluence_get_page",
  confluence_list_spaces: "confluence_list_spaces",
  confluence_create_page: "confluence_create_page",
  sf_query: "sf_query",
  sf_search: "sf_search",
  sf_get_record: "sf_get_record",
  sf_create_record: "sf_create_record",
  github_search_issues: "github_search_issues",
  github_get_issue: "github_get_issue",
  github_create_issue: "github_create_issue",
  github_list_prs: "github_list_prs",
  github_list_commits: "github_list_commits",
  github_get_file: "github_get_file",
  sf_tooling_query: "sf_tooling_query",
  sf_create_apex: "sf_create_apex",
  sf_create_lwc: "sf_create_lwc",
  sf_execute_anonymous: "sf_execute_anonymous",
  sf_describe_metadata: "sf_describe_metadata",
  sf_tooling_create: "sf_tooling_create",
  sf_tooling_update: "sf_tooling_update",
  sf_tooling_delete: "sf_tooling_delete",
  sf_create_custom_object: "sf_create_custom_object",
  sf_create_custom_field: "sf_create_custom_field",
  sf_describe_object: "sf_describe_object",
  sf_metadata_read: "sf_metadata_read",
  sf_create_validation_rule: "sf_create_validation_rule",
};

async function callMcp(toolName, args, env) {
  try {
    // Use service binding (env.MCP) to call the MCP worker directly
    const response = await env.MCP.fetch("https://mcp/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("MCP HTTP error:", response.status, errText);
      return JSON.stringify({ error: `MCP returned ${response.status}` });
    }

    const result = await response.json();
    if (result.result?.content?.[0]?.text) {
      return result.result.content[0].text;
    }
    return JSON.stringify(result.result || result.error || { error: "MCP call failed" });
  } catch (err) {
    console.error("MCP fetch error:", err.message || err);
    return JSON.stringify({ error: "Failed to reach MCP server", detail: err.message });
  }
}

async function executeTool(name, input, env, userName) {
  const mcpName = TOOL_NAME_MAP[name];
  if (!mcpName) {
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  }

  // Inject author for save operations
  const args = { ...input };
  if (name === "save_to_brain" && userName) {
    args.author = userName;
  }

  return await callMcp(mcpName, args, env);
}

// --- Rate Limiting ---

const ipCounts = new Map();
const sessionCounts = new Map();
const IP_LIMIT = 30;
const SESSION_LIMIT = 100;
const IP_WINDOW_MS = 60 * 60 * 1000;
const DAILY_CAP = 2000;
let dailyCount = 0;
let dailyResetAt = Date.now() + 24 * 60 * 60 * 1000;

function checkRateLimit(ip, sessionId) {
  const now = Date.now();
  if (now > dailyResetAt) {
    dailyCount = 0;
    dailyResetAt = now + 24 * 60 * 60 * 1000;
  }
  if (dailyCount >= DAILY_CAP) {
    return { allowed: false, reason: "Daily limit reached." };
  }
  let ipData = ipCounts.get(ip);
  if (!ipData || now > ipData.resetAt) {
    ipData = { count: 0, resetAt: now + IP_WINDOW_MS };
    ipCounts.set(ip, ipData);
  }
  if (ipData.count >= IP_LIMIT) {
    return { allowed: false, reason: "Too many messages. Wait a moment." };
  }
  if (sessionId) {
    let sessData = sessionCounts.get(sessionId);
    if (!sessData) {
      sessData = { count: 0 };
      sessionCounts.set(sessionId, sessData);
    }
    if (sessData.count >= SESSION_LIMIT) {
      return { allowed: false, reason: "Session limit reached. Start a new chat." };
    }
    sessData.count++;
  }
  ipData.count++;
  dailyCount++;
  return { allowed: true };
}

// --- CORS ---

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

// --- SSE Stream with Tool Use ---

async function streamWithToolUse(
  messages,
  writer,
  encoder,
  env,
  userName,
  depth = 0
) {
  if (depth > 5) {
    await writer.write(
      encoder.encode(
        `data: ${JSON.stringify({ type: "text_delta", text: "I had trouble processing that. Please try again." })}\n\n`
      )
    );
    return;
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages,
      tools: TOOLS,
      stream: true,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("Anthropic API error:", response.status, errText);
    let userMessage = "I ran into an issue processing that request.";
    if (response.status === 429) {
      userMessage = "I'm getting too many requests right now — give me a moment and try again.";
    } else if (response.status === 413 || errText.includes("too many tokens")) {
      userMessage = "That request was too large for me to process. Try asking something more specific or starting a new conversation.";
    } else if (response.status === 401) {
      userMessage = "There's an authentication issue with the AI service. Let the team know so they can check the API key.";
    } else if (response.status === 400) {
      userMessage = "I had trouble understanding that request. Could you rephrase it or be more specific about what you're looking for?";
    } else if (response.status === 500 || response.status === 502 || response.status === 503) {
      userMessage = "The AI service is having issues right now. Try again in a few seconds.";
    } else {
      userMessage = `Something went wrong (error ${response.status}). Could you try rephrasing your question?`;
    }
    console.error("Sending user-friendly error:", userMessage);
    await writer.write(
      encoder.encode(
        `data: ${JSON.stringify({ type: "error", message: userMessage })}\n\n`
      )
    );
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Track the full response for conversation history
  let fullContent = [];
  let toolUseBlocks = [];

  // Per-block state
  let currentBlockType = null;
  let currentText = "";
  let currentToolBlock = null;
  let toolInputJson = "";
  let stopReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);

      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;

      try {
        const event = JSON.parse(data);

        switch (event.type) {
          case "content_block_start":
            if (event.content_block.type === "text") {
              currentBlockType = "text";
              currentText = "";
            } else if (event.content_block.type === "tool_use") {
              currentBlockType = "tool_use";
              currentToolBlock = {
                type: "tool_use",
                id: event.content_block.id,
                name: event.content_block.name,
              };
              toolInputJson = "";
            }
            break;

          case "content_block_delta":
            if (event.delta.type === "text_delta") {
              currentText += event.delta.text;
              // Forward text to client in real time
              await writer.write(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "text_delta", text: event.delta.text })}\n\n`
                )
              );
            } else if (event.delta.type === "input_json_delta") {
              toolInputJson += event.delta.partial_json;
            }
            break;

          case "content_block_stop":
            if (currentBlockType === "text" && currentText) {
              fullContent.push({ type: "text", text: currentText });
            } else if (currentBlockType === "tool_use" && currentToolBlock) {
              try {
                currentToolBlock.input = JSON.parse(toolInputJson);
              } catch {
                currentToolBlock.input = {};
              }
              fullContent.push({ ...currentToolBlock });
              toolUseBlocks.push({ ...currentToolBlock });
              currentToolBlock = null;
            }
            currentBlockType = null;
            break;

          case "message_delta":
            if (event.delta?.stop_reason) {
              stopReason = event.delta.stop_reason;
            }
            break;
        }
      } catch {
        // skip unparseable
      }
    }
  }

  // If Claude used tools, execute them and recurse
  if (stopReason === "tool_use" && toolUseBlocks.length > 0) {
    // Tell client we're accessing the brain
    await writer.write(
      encoder.encode(
        `data: ${JSON.stringify({ type: "brain_activity", message: "Accessing shared brain..." })}\n\n`
      )
    );

    const toolResults = [];
    for (const tool of toolUseBlocks) {
      console.log("Calling MCP tool:", tool.name, JSON.stringify(tool.input));
      const result = await executeTool(tool.name, tool.input, env, userName);
      console.log("MCP result length:", result?.length, "preview:", result?.substring(0, 200));
      toolResults.push({
        type: "tool_result",
        tool_use_id: tool.id,
        content: result,
      });
    }

    // Build updated messages and recurse
    const newMessages = [
      ...messages,
      { role: "assistant", content: fullContent },
      { role: "user", content: toolResults },
    ];

    console.log("Recursing with tool results, depth:", depth + 1);
    await streamWithToolUse(newMessages, writer, encoder, env, userName, depth + 1);
  }
}

// --- Main Handler ---

export default {
  async fetch(request, env) {
    const corsHeaders = getCorsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    try {
      const body = await request.json();
      const { messages, sessionId, userName } = body;

      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return new Response(
          JSON.stringify({ error: "Messages array required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // Rate limit
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rateCheck = checkRateLimit(ip, sessionId);
      if (!rateCheck.allowed) {
        return new Response(JSON.stringify({ error: rateCheck.reason }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Cap conversation length
      const trimmedMessages = messages.slice(-30);

      // Create SSE stream
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      // Process in background
      (async () => {
        try {
          await streamWithToolUse(trimmedMessages, writer, encoder, env, userName);
          // Send done event
          await writer.write(
            encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`)
          );
          await writer.close();
        } catch (e) {
          console.error("Stream error:", e);
          const errMsg = e?.message || String(e);
          let userMessage = "Something unexpected happened. Could you try again or rephrase your question?";
          if (errMsg.includes("tool") || errMsg.includes("MCP")) {
            userMessage = `I had trouble using one of my tools: ${errMsg}. Could you try rephrasing what you need?`;
          }
          try {
            await writer.write(
              encoder.encode(
                `data: ${JSON.stringify({ type: "error", message: userMessage })}\n\n`
              )
            );
            await writer.close();
          } catch {
            await writer.abort(e);
          }
        }
      })();

      return new Response(readable, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    } catch (e) {
      console.error("Worker error:", e);
      return new Response(JSON.stringify({ error: "Something went wrong" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  },
};
