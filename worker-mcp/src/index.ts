import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerDashboardTool } from "./tools/dashboard";
import { registerNoteTools } from "./tools/notes";
import { registerUserTools } from "./tools/users";
import { registerJiraTools } from "./tools/jira";
import { registerConfluenceTools } from "./tools/confluence";
import { registerSalesforceTools } from "./tools/salesforce";
import { registerGitHubTools } from "./tools/github";
import { registerOnboardingTools } from "./tools/onboarding";

export interface Env {
  DB: D1Database;
  JIRA_BASE_URL: string;
  JIRA_EMAIL: string;
  JIRA_API_TOKEN: string;
  CONFLUENCE_API_TOKEN: string;
  SF_INSTANCE_URL: string;
  SF_CLIENT_ID: string;
  SF_CLIENT_SECRET: string;
  GITHUB_TOKEN: string;
  GITHUB_REPO: string;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

async function runMigrations(db: D1Database) {
  try {
    // Auto-add team_role column if it doesn't exist
    const tableInfo = await db.prepare("PRAGMA table_info(users)").all();
    const columns = (tableInfo.results || []).map((r: any) => r.name);
    if (!columns.includes("team_role")) {
      await db.prepare("ALTER TABLE users ADD COLUMN team_role TEXT DEFAULT 'developer'").run();
      console.log("Migration: added team_role column to users table");
    }
  } catch (e) {
    console.error("Migration error:", e);
  }
}

function createServer(env: Env): McpServer {
  const server = new McpServer({
    name: "team-brain-mcp-server",
    version: "1.0.0",
  });
  registerDashboardTool(server, env.DB);
  registerNoteTools(server, env.DB);
  registerUserTools(server, env.DB);
  // Pass Confluence config to onboarding so it can fetch pages directly
  const confluenceConfig = env.CONFLUENCE_API_TOKEN
    ? {
        baseUrl: env.JIRA_BASE_URL || "https://carrera328.atlassian.net",
        email: env.JIRA_EMAIL || "carrera.328@gmail.com",
        apiToken: env.CONFLUENCE_API_TOKEN,
      }
    : undefined;
  registerOnboardingTools(server, env.DB, confluenceConfig);

  // Jira integration
  if (env.JIRA_API_TOKEN) {
    registerJiraTools(server, {
      baseUrl: env.JIRA_BASE_URL || "https://carrera328.atlassian.net",
      email: env.JIRA_EMAIL || "carrera.328@gmail.com",
      apiToken: env.JIRA_API_TOKEN,
    });
  }

  // Confluence integration
  if (env.CONFLUENCE_API_TOKEN) {
    registerConfluenceTools(server, {
      baseUrl: env.JIRA_BASE_URL || "https://carrera328.atlassian.net",
      email: env.JIRA_EMAIL || "carrera.328@gmail.com",
      apiToken: env.CONFLUENCE_API_TOKEN,
    });
  }

  // GitHub integration
  if (env.GITHUB_TOKEN) {
    registerGitHubTools(server, {
      token: env.GITHUB_TOKEN,
      defaultRepo: env.GITHUB_REPO || "gmarkay/team-brain-sfdc",
    });
  }

  // Salesforce integration
  if (env.SF_CLIENT_ID) {
    registerSalesforceTools(server, {
      instanceUrl: env.SF_INSTANCE_URL || "orgfarm-9f4a8cd667-dev-ed.develop.my.salesforce.com",
      clientId: env.SF_CLIENT_ID,
      clientSecret: env.SF_CLIENT_SECRET,
    });
  }

  return server;
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, mcp-session-id, mcp-protocol-version",
};

// ---------------------------------------------------------------------------
// Main fetch handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Health check
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(
        JSON.stringify({ status: "ok", service: "team-brain-mcp" }),
        { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    // MCP endpoint
    if (url.pathname !== "/mcp") {
      return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
    }

    // Run auto-migrations on first request
    await runMigrations(env.DB);

    // Create MCP server & handle request (stateless)
    const server = createServer(env);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(request);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        ...Object.fromEntries(response.headers.entries()),
        ...CORS_HEADERS,
      },
    });
  },
};
