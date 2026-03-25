import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface ConfluenceConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

async function confluenceFetch(config: ConfluenceConfig, path: string, options?: RequestInit) {
  const auth = btoa(`${config.email}:${config.apiToken}`);
  const resp = await fetch(`${config.baseUrl}/wiki/api/v2${path}`, {
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
    throw new Error(`Confluence API ${resp.status}: ${body}`);
  }
  return resp.json();
}

// Convert Confluence storage format (HTML) to plain text
function htmlToText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<li>/gi, "• ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function registerConfluenceTools(server: McpServer, config: ConfluenceConfig) {
  // -----------------------------------------------------------------------
  // Search Confluence
  // -----------------------------------------------------------------------
  server.registerTool(
    "confluence_search",
    {
      title: "Search Confluence",
      description:
        "Search Confluence pages and documentation. Use when someone asks about docs, runbooks, processes, architecture, onboarding, or any team documentation.",
      inputSchema: {
        query: z
          .string()
          .describe("Search term — matches page titles and content"),
        maxResults: z
          .number()
          .default(10)
          .describe("Max results to return (default 10)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, maxResults }) => {
      try {
        // Use CQL (Confluence Query Language) for search
        const auth = btoa(`${config.email}:${config.apiToken}`);
        const cql = `type=page AND (title~"${query}" OR text~"${query}")`;
        const resp = await fetch(
          `${config.baseUrl}/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${maxResults}&expand=body.view,space,version`,
          {
            headers: {
              Authorization: `Basic ${auth}`,
              Accept: "application/json",
            },
          }
        );

        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`Confluence search ${resp.status}: ${errText}`);
        }

        const data: any = await resp.json();

        if (!data.results || data.results.length === 0) {
          return { content: [{ type: "text" as const, text: "No Confluence pages found." }] };
        }

        const results = data.results.map((page: any) => {
          const bodyText = htmlToText(page.body?.view?.value || "");
          return {
            id: page.id,
            title: page.title,
            space: page.space?.name || page.space?.key,
            lastUpdated: page.version?.when,
            updatedBy: page.version?.by?.displayName,
            excerpt: bodyText.length > 500 ? bodyText.substring(0, 500) + "..." : bodyText,
            url: `${config.baseUrl}/wiki${page._links?.webui || ""}`,
          };
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Confluence search error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Get page details
  // -----------------------------------------------------------------------
  server.registerTool(
    "confluence_get_page",
    {
      title: "Get Confluence Page",
      description:
        "Get the full content of a specific Confluence page by ID. Use after searching to read the full page.",
      inputSchema: {
        pageId: z.string().describe("The Confluence page ID (from search results)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ pageId }) => {
      try {
        const auth = btoa(`${config.email}:${config.apiToken}`);
        const resp = await fetch(
          `${config.baseUrl}/wiki/rest/api/content/${pageId}?expand=body.view,space,version,children.comment`,
          {
            headers: {
              Authorization: `Basic ${auth}`,
              Accept: "application/json",
            },
          }
        );

        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`Confluence page ${resp.status}: ${errText}`);
        }

        const page: any = await resp.json();
        const bodyText = htmlToText(page.body?.view?.value || "");

        const result = {
          id: page.id,
          title: page.title,
          space: page.space?.name || page.space?.key,
          content: bodyText.length > 3000 ? bodyText.substring(0, 3000) + "\n\n[Content truncated...]" : bodyText,
          lastUpdated: page.version?.when,
          updatedBy: page.version?.by?.displayName,
          version: page.version?.number,
          url: `${config.baseUrl}/wiki${page._links?.webui || ""}`,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Confluence error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // List spaces
  // -----------------------------------------------------------------------
  server.registerTool(
    "confluence_list_spaces",
    {
      title: "List Confluence Spaces",
      description:
        "List all Confluence spaces. Use to see what documentation areas exist.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const data: any = await confluenceFetch(config, "/spaces?limit=25");

        const spaces = (data.results || []).map((s: any) => ({
          id: s.id,
          key: s.key,
          name: s.name,
          type: s.type,
          description: s.description?.plain?.value || "",
          url: `${config.baseUrl}/wiki/spaces/${s.key}`,
        }));

        if (spaces.length === 0) {
          return { content: [{ type: "text" as const, text: "No Confluence spaces found." }] };
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(spaces, null, 2) }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Confluence error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Create page
  // -----------------------------------------------------------------------
  server.registerTool(
    "confluence_create_page",
    {
      title: "Create Confluence Page",
      description:
        "Create a new page in Confluence. Use when someone wants to write documentation, create a runbook, or publish team knowledge.",
      inputSchema: {
        title: z.string().min(1).describe("Page title"),
        content: z.string().min(1).describe("Page content in plain text. Will be converted to Confluence format."),
        spaceKey: z
          .string()
          .default("SD")
          .describe('Confluence space key (default "SD" for Software Development)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ title, content, spaceKey }) => {
      try {
        // Convert plain text to simple HTML for Confluence storage format
        const htmlContent = content
          .split("\n\n")
          .map((block: string) => {
            const trimmed = block.trim();
            if (trimmed.startsWith("# ")) return `<h1>${trimmed.slice(2)}</h1>`;
            if (trimmed.startsWith("## ")) return `<h2>${trimmed.slice(3)}</h2>`;
            if (trimmed.startsWith("### ")) return `<h3>${trimmed.slice(4)}</h3>`;
            if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
              const items = trimmed
                .split("\n")
                .map((line: string) => `<li>${line.replace(/^[-*]\s*/, "")}</li>`)
                .join("");
              return `<ul>${items}</ul>`;
            }
            return `<p>${trimmed.replace(/\n/g, "<br/>")}</p>`;
          })
          .join("");

        const auth = btoa(`${config.email}:${config.apiToken}`);
        const resp = await fetch(`${config.baseUrl}/wiki/rest/api/content`, {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            type: "page",
            title,
            space: { key: spaceKey },
            body: {
              storage: {
                value: htmlContent,
                representation: "storage",
              },
            },
          }),
        });

        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`Confluence create ${resp.status}: ${errText}`);
        }

        const page: any = await resp.json();
        return {
          content: [{
            type: "text" as const,
            text: `Page "${title}" created in ${spaceKey}!\nURL: ${config.baseUrl}/wiki${page._links?.webui || ""}`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Confluence create error: ${e.message}` }] };
      }
    }
  );
}
