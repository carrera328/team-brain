import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerNoteTools(server: McpServer, db: D1Database) {
  server.registerTool(
    "tb_save_entry",
    {
      title: "Save Entry",
      description:
        "Save a note, idea, decision, action item, learning, or resource to the team's shared brain.",
      inputSchema: {
        title: z
          .string()
          .min(1)
          .max(300)
          .describe("A clear, concise title"),
        content: z.string().min(1).describe("The full content to save"),
        category: z
          .enum([
            "idea",
            "decision",
            "note",
            "action-item",
            "learning",
            "resource",
          ])
          .default("note")
          .describe("Category for organization"),
        author: z
          .string()
          .optional()
          .describe("Who contributed this"),
        tags: z
          .array(z.string())
          .default([])
          .describe("Tags for easier searching"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ title, content, category, author, tags }) => {
      const ts = new Date().toISOString();
      await db
        .prepare(
          "INSERT INTO entries (title, content, category, author, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
        )
        .bind(
          title,
          content,
          category,
          author ?? null,
          JSON.stringify(tags),
          ts,
          ts
        )
        .run();

      return {
        content: [
          {
            type: "text" as const,
            text: `Entry '${title}' saved as '${category}'.`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "tb_search_entries",
    {
      title: "Search Entries",
      description:
        "Search the team's shared brain by title, content, or category.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Search title or content"),
        category: z
          .enum([
            "idea",
            "decision",
            "note",
            "action-item",
            "learning",
            "resource",
          ])
          .optional()
          .describe("Filter by category"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, category }) => {
      const conditions: string[] = [];
      const params: any[] = [];

      if (query) {
        conditions.push("(title LIKE ? OR content LIKE ?)");
        const q = `%${query}%`;
        params.push(q, q);
      }
      if (category) {
        conditions.push("category = ?");
        params.push(category);
      }

      const where =
        conditions.length > 0 ? conditions.join(" AND ") : "1=1";
      const stmt = db.prepare(
        `SELECT * FROM entries WHERE ${where} ORDER BY updated_at DESC LIMIT 20`
      );
      const { results: rows } =
        params.length > 0
          ? await stmt.bind(...params).all()
          : await stmt.all();

      if (rows.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No entries found." },
          ],
        };
      }

      const results = rows.map((r: any) => ({
        id: r.id,
        title: r.title,
        content:
          r.content.length > 500
            ? r.content.substring(0, 500) + "..."
            : r.content,
        category: r.category,
        author: r.author,
        tags: JSON.parse(r.tags || "[]"),
        created_at: r.created_at,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    }
  );
}
