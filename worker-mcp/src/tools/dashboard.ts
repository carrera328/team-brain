import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerDashboardTool(server: McpServer, db: D1Database) {
  server.registerTool(
    "tb_dashboard",
    {
      title: "Dashboard",
      description:
        "Get a summary of everything in the team's shared brain: total entries, breakdown by category, and recent items.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const [totalCount, categoryCounts, recentEntries] = await db.batch([
        db.prepare("SELECT COUNT(*) as c FROM entries"),
        db.prepare(
          "SELECT category, COUNT(*) as c FROM entries GROUP BY category ORDER BY c DESC"
        ),
        db.prepare(
          "SELECT title, category, author, created_at FROM entries ORDER BY created_at DESC LIMIT 10"
        ),
      ]);

      const dashboard = {
        total_entries: (totalCount.results[0] as any)?.c ?? 0,
        by_category: Object.fromEntries(
          categoryCounts.results.map((r: any) => [r.category, r.c])
        ),
        recent: recentEntries.results.map((r: any) => ({
          title: r.title,
          category: r.category,
          author: r.author,
          created: r.created_at,
        })),
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(dashboard, null, 2),
          },
        ],
      };
    }
  );
}
