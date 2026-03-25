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
        // Split query into words and match ANY word in title or content
        const words = query.split(/\s+/).filter((w: string) => w.length > 0);
        if (words.length > 0) {
          const wordConditions = words.map(() => "(title LIKE ? OR content LIKE ? OR tags LIKE ?)");
          conditions.push(`(${wordConditions.join(" OR ")})`);
          for (const word of words) {
            const q = `%${word}%`;
            params.push(q, q, q);
          }
        }
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
        status: r.status || "open",
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

  server.registerTool(
    "tb_update_entry",
    {
      title: "Update Entry",
      description:
        "Update an existing brain entry. Use this to change status, append content, or modify an entry. Always search first to find the entry ID.",
      inputSchema: {
        id: z.number().describe("The entry ID to update (from search results)"),
        status: z
          .enum(["open", "in-progress", "done", "blocked", "cancelled"])
          .optional()
          .describe("Update the status"),
        append_content: z
          .string()
          .optional()
          .describe("Text to append to the existing content (e.g. status update, follow-up note)"),
        category: z
          .enum(["idea", "decision", "note", "action-item", "learning", "resource"])
          .optional()
          .describe("Change the category"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Replace tags"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id, status, append_content, category, tags }) => {
      const existing = await db
        .prepare("SELECT * FROM entries WHERE id = ?")
        .bind(id)
        .first<any>();

      if (!existing) {
        return {
          content: [{ type: "text" as const, text: `Entry #${id} not found.` }],
        };
      }

      const ts = new Date().toISOString();
      const updates: string[] = ["updated_at = ?"];
      const params: any[] = [ts];

      if (status) {
        updates.push("status = ?");
        params.push(status);
      }
      if (append_content) {
        updates.push("content = ?");
        params.push(existing.content + "\n\n---\n" + append_content);
      }
      if (category) {
        updates.push("category = ?");
        params.push(category);
      }
      if (tags) {
        updates.push("tags = ?");
        params.push(JSON.stringify(tags));
      }

      params.push(id);
      await db
        .prepare(`UPDATE entries SET ${updates.join(", ")} WHERE id = ?`)
        .bind(...params)
        .run();

      const changes: string[] = [];
      if (status) changes.push(`status → ${status}`);
      if (append_content) changes.push("content appended");
      if (category) changes.push(`category → ${category}`);
      if (tags) changes.push(`tags updated`);

      return {
        content: [
          {
            type: "text" as const,
            text: `Entry #${id} '${existing.title}' updated: ${changes.join(", ")}.`,
          },
        ],
      };
    }
  );
}
