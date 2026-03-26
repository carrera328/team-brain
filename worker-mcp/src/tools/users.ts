import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerUserTools(server: McpServer, db: D1Database) {
  server.registerTool(
    "tb_add_user",
    {
      title: "Add User",
      description:
        "Add or update a team member who can authenticate to the shared brain via Google Sign-In.",
      inputSchema: {
        email: z
          .string()
          .email()
          .describe("Email address"),
        name: z
          .string()
          .optional()
          .describe("Display name"),
        role: z
          .enum(["admin", "member"])
          .default("member")
          .describe("Role: 'admin' or 'member'"),
        team_role: z
          .enum(["developer", "qa", "product_owner", "scrum_master", "designer", "ba"])
          .optional()
          .describe("Team role: developer, qa, product_owner, scrum_master, designer, or ba"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ email, name, role, team_role }) => {
      const ts = new Date().toISOString();
      const normalizedEmail = email.toLowerCase();
      await db
        .prepare(
          `INSERT INTO users (email, name, role, team_role, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(email) DO UPDATE SET
             name = COALESCE(excluded.name, users.name),
             role = excluded.role,
             team_role = COALESCE(excluded.team_role, users.team_role),
             updated_at = excluded.updated_at`
        )
        .bind(normalizedEmail, name || null, role, team_role || "developer", ts, ts)
        .run();

      return {
        content: [
          {
            type: "text" as const,
            text: `User '${normalizedEmail}' added with role '${role}', team_role '${team_role || "developer"}'.`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "tb_list_users",
    {
      title: "List Users",
      description:
        "List all team members authorized to access the shared brain.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const { results: rows } = await db
        .prepare("SELECT * FROM users ORDER BY created_at DESC")
        .all();

      if (rows.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No users found." },
          ],
        };
      }

      const users = rows.map((r: any) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        role: r.role,
        team_role: r.team_role || "developer",
        created_at: r.created_at,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(users, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    "tb_remove_user",
    {
      title: "Remove User",
      description:
        "Remove a team member and revoke their access tokens.",
      inputSchema: {
        email: z
          .string()
          .email()
          .describe("Email of the user to remove"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ email }) => {
      const normalizedEmail = email.toLowerCase();

      const user = await db
        .prepare("SELECT id FROM users WHERE email = ?")
        .bind(normalizedEmail)
        .first();

      if (!user) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No user found with email '${normalizedEmail}'.`,
            },
          ],
        };
      }

      await db.batch([
        db
          .prepare("DELETE FROM users WHERE email = ?")
          .bind(normalizedEmail),
        db
          .prepare("DELETE FROM oauth_tokens WHERE user_email = ?")
          .bind(normalizedEmail),
        db
          .prepare(
            "DELETE FROM oauth_refresh_tokens WHERE user_email = ?"
          )
          .bind(normalizedEmail),
      ]);

      return {
        content: [
          {
            type: "text" as const,
            text: `User '${normalizedEmail}' removed and all tokens revoked.`,
          },
        ],
      };
    }
  );
}
