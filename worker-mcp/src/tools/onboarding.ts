import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface ConfluenceConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

function htmlToText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<h[1-6][^>]*>/gi, "\n### ")
    .replace(/<li>/gi, "- ")
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

async function fetchConfluencePage(config: ConfluenceConfig, pageId: string): Promise<{title: string, content: string, link: string} | null> {
  try {
    const auth = btoa(`${config.email}:${config.apiToken}`);
    const resp = await fetch(`${config.baseUrl}/wiki/rest/api/content/${pageId}?expand=body.storage`, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
    });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    return {
      title: data.title,
      content: htmlToText(data.body?.storage?.value || ""),
      link: `${config.baseUrl}/wiki${data._links?.webui || `/spaces/SD/pages/${pageId}`}`,
    };
  } catch {
    return null;
  }
}

// QA onboarding Confluence page IDs
const QA_ONBOARDING_PAGES = ["1015810", "1015826", "1048577"];

// Developer onboarding — add page IDs here when created
const DEV_ONBOARDING_PAGES: string[] = [];

export function registerOnboardingTools(server: McpServer, db: D1Database, confluenceConfig?: ConfluenceConfig) {
  server.registerTool(
    "tb_onboard_user",
    {
      title: "Onboard Team Member",
      description:
        "Start a role-based onboarding experience for a new team member. Use this when someone says 'I'm [name] and I'm a [role]' or asks about onboarding. Returns a personalized onboarding guide based on their team role with links to all relevant tools and resources.",
      inputSchema: {
        name: z.string().describe("The person's name"),
        email: z.string().email().optional().describe("Their email address"),
        team_role: z
          .enum(["developer", "qa", "product_owner", "scrum_master", "designer", "ba"])
          .describe("Their team role"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ name, email, team_role }) => {
      const ts = new Date().toISOString();

      // Save or update user in database
      if (email) {
        const normalizedEmail = email.toLowerCase();
        await db
          .prepare(
            `INSERT INTO users (email, name, role, team_role, created_at, updated_at)
             VALUES (?, ?, 'member', ?, ?, ?)
             ON CONFLICT(email) DO UPDATE SET
               name = COALESCE(excluded.name, users.name),
               team_role = excluded.team_role,
               updated_at = excluded.updated_at`
          )
          .bind(normalizedEmail, name, team_role, ts, ts)
          .run();
      }

      // Log onboarding event to brain
      await db
        .prepare(
          `INSERT INTO entries (title, content, category, author, tags, status, created_at, updated_at)
           VALUES (?, ?, 'note', ?, '["onboarding"]', 'done', ?, ?)`
        )
        .bind(
          `Onboarding: ${name} (${team_role})`,
          `${name} completed onboarding as ${team_role} on ${ts}.`,
          name,
          ts,
          ts
        )
        .run();

      // Fetch role-specific Confluence pages
      let confluenceContent = "";
      const pageIds = team_role === "qa" ? QA_ONBOARDING_PAGES : DEV_ONBOARDING_PAGES;

      if (confluenceConfig && pageIds.length > 0) {
        const pages = await Promise.all(
          pageIds.map((id) => fetchConfluencePage(confluenceConfig, id))
        );

        const fetched = pages.filter((p) => p !== null) as { title: string; content: string; link: string }[];

        if (fetched.length > 0) {
          confluenceContent = `

---

# 📚 Your Onboarding Documentation

FORMATTING INSTRUCTIONS FOR THE AI: Present each document below as its own visually distinct section. Use a header with an emoji and the document title, then render the content inside a markdown code block or quote block so it stands out from the rest of the message. Include the clickable link at the end of each section. Put a horizontal rule between each document. Walk the user through each document one at a time — summarize the key takeaways after each one.

`;

          for (let i = 0; i < fetched.length; i++) {
            const page = fetched[i];
            confluenceContent += `
---

## 📄 Document ${i + 1} of ${fetched.length}: ${page.title}

> **Source:** [${page.title}](${page.link})

\`\`\`
${page.content}
\`\`\`

**Key takeaways to highlight for the user from this document ^**

🔗 **Open full doc:** ${page.link}

`;
          }

          confluenceContent += `
---

✅ **All ${fetched.length} onboarding documents have been loaded above.**

After presenting each document, ask the user:
1. Do you have questions about any of the documents?
2. Are you ready to start your first task?
3. Would you like me to create a Jira ticket for your first assignment?
`;
        }
      }

      // Build role-specific onboarding content
      const guide = buildOnboardingGuide(name, team_role);

      return {
        content: [{ type: "text" as const, text: guide + confluenceContent }],
      };
    }
  );
}

function buildOnboardingGuide(name: string, role: string): string {
  const common = `
# Welcome to The Catalyst Crew, ${name}! 🚀

You're joining our Innovation Week team. Here's everything you need to get started.

## Team Members
- **Sal Carrera** — Admin/Developer (Team Lead)
- **Griffin Markay** — Developer
- **Venkata Gorrepati** — Developer
- **Rekha Gorrepati** — QA
- **Perry Golas** — Product Owner

## Our Project: Team Brain
We're building a shared MCP (Model Context Protocol) server that connects multiple data sources into one AI-powered interface. Think of it as a shared brain for the team.

## Connected Systems
| System | What it does | URL |
|--------|-------------|-----|
| **Jira** | Sprint tracking, bugs, stories | https://discoveryacdc.atlassian.net/jira/software/projects/SCRUM/boards/1 |
| **Confluence** | Team docs, runbooks | https://discoveryacdc.atlassian.net/wiki/spaces/SD |
| **Salesforce** | CRM / dev org | orgfarm-9f4a8cd667-dev-ed.develop.my.salesforce.com |
| **GitHub** | Source code | https://github.com/gmarkay/team-brain-sfdc |
| **Team Brain Chat** | This chat interface | https://team-brain-chat.carrera-328.workers.dev |
`;

  const roleGuides: Record<string, string> = {
    developer: `
## Your Developer Onboarding

### 1. GitHub Access
You need access to two repos:
- **[carrera328/team-brain](https://github.com/carrera328/team-brain)** — The MCP server + chat UI (Cloudflare Workers)
- **[gmarkay/team-brain-sfdc](https://github.com/gmarkay/team-brain-sfdc)** — Salesforce metadata + LWCs

### 2. How to Contribute
\`\`\`bash
# Clone the repo
git clone https://github.com/carrera328/team-brain.git
cd team-brain

# Create a feature branch
git checkout -b feature/SCRUM-XX-your-feature

# Make changes, then push
git push origin feature/SCRUM-XX-your-feature

# Open a PR against master
# When merged → GitHub Actions auto-deploys both workers to Cloudflare
\`\`\`

### 3. Architecture
- **worker/** — Chat UI worker (proxies to Claude API, auto-discovers MCP tools)
- **worker-mcp/** — MCP server (D1 database + Jira + Confluence + Salesforce + GitHub integrations)
- **migration.sql** — Database schema
- Push to master → GitHub Actions deploys automatically

### 4. Local Development
\`\`\`bash
cd worker && npx wrangler dev      # Chat UI on localhost:8787
cd worker-mcp && npx wrangler dev  # MCP server on localhost:8788
\`\`\`

### 5. Jira Workflow
- Pick up stories from the **SCRUM** board: https://discoveryacdc.atlassian.net/jira/software/projects/SCRUM/boards/1
- Move tickets: To Do → In Progress → Done
- Name branches after tickets: \`feature/SCRUM-5-add-search\`

### 6. Salesforce Dev
- The org is a Developer Edition with full API access
- You can create Apex, LWCs, custom objects, and metadata through the MCP tools
- Ask the brain: "create an Apex class called HelloWorld" — it works!
`,

    qa: `
## Your QA Onboarding

### 1. Jira — Your Home Base
- **Board**: https://discoveryacdc.atlassian.net/jira/software/projects/SCRUM/boards/1
- Filter by type **Bug** to see current issues
- Create bugs with clear repro steps, expected vs actual behavior
- You can create bugs right here in the chat: "Create a bug in SCRUM: [description]"

### 2. What to Test
The main product is the **Team Brain chat interface**: https://team-brain-chat.carrera-328.workers.dev
- Test that brain saves/searches work correctly
- Test that Jira integration returns real data
- Test that Confluence search and page creation work
- Test that Salesforce queries return results
- Test across browsers and devices

### 3. Confluence — QA Documentation
Your onboarding docs have been fetched and included below — review each section carefully.

### 4. Salesforce QA Sandbox
- Org: orgfarm-9f4a8cd667-dev-ed.develop.my.salesforce.com
- Test CRUD operations on Accounts, Contacts, Opportunities
- Verify that records created through the chat actually appear in the org

### 5. How to Report Bugs
Either:
- Tell the brain: "Create a bug: the search returns no results when I search for 'author'"
- Or create directly in Jira with these fields:
  - **Type**: Bug
  - **Priority**: High/Medium/Low
  - **Description**: Steps to reproduce, expected result, actual result
  - **Labels**: qa-found

### 6. Edge Cases to Watch
- What happens with very long inputs?
- What happens when the MCP server is down?
- Do error messages make sense to users?
- Is the chat responsive on mobile?
`,

    product_owner: `
## Your Product Owner Onboarding

### 1. Jira — Backlog Management
- **Board**: https://discoveryacdc.atlassian.net/jira/software/projects/SCRUM/boards/1
- Review and prioritize the backlog
- Create and refine user stories
- You can create stories right here: "Create a story in SCRUM: As a user, I want to..."

### 2. Confluence — Product Documentation
- **Space**: https://discoveryacdc.atlassian.net/wiki/spaces/SD
- Write requirements, acceptance criteria, and feature specs
- Document decisions and their rationale in the brain

### 3. The Demo
Our Innovation Week demo shows:
1. **One MCP server** connecting Jira, Confluence, Salesforce, GitHub, and a shared brain
2. **Multiple clients** — our chat UI, ChatGPT, and Claude Code all use the same server
3. **Role-based onboarding** — this experience you're going through right now!
4. **Real-time collaboration** — what you save in the brain, everyone else sees instantly

### 4. Key Decisions to Track
Use the brain to log decisions: "Save this decision: We chose Cloudflare Workers over AWS Lambda because..."
- Every decision gets timestamped and attributed
- Anyone can ask "why did we choose X" later

### 5. Sprint Ceremonies
- Ask the brain: "What's in the current sprint?" to get a live view
- Ask: "What's the status of all our work?" for a dashboard
- Use the brain to capture action items from standups and retros
`,

    ba: `
## Your BA Onboarding

### 1. Requirements & Documentation
- **Confluence**: https://discoveryacdc.atlassian.net/wiki/spaces/SD
- Document requirements, acceptance criteria, and process flows
- Create pages through the chat: "Create a Confluence page called Requirements: [feature]"

### 2. Jira — Story Management
- **Board**: https://discoveryacdc.atlassian.net/jira/software/projects/SCRUM/boards/1
- Write user stories with clear acceptance criteria
- Track requirements through the sprint

### 3. Using the Brain for Requirements
- Save requirements: "Save this requirement: Users must be able to search across all connected systems"
- Track decisions: "Save this decision: We're using Cloudflare D1 for the database"
- Anyone can query: "What are the requirements for onboarding?"

### 4. Salesforce
- Org: orgfarm-9f4a8cd667-dev-ed.develop.my.salesforce.com
- Understand the data model by asking: "Describe the Account object in Salesforce"
- Document business rules and validation requirements
`,

    scrum_master: `
## Your Scrum Master Onboarding

### 1. Jira — Sprint Management
- **Board**: https://discoveryacdc.atlassian.net/jira/software/projects/SCRUM/boards/1
- Manage sprint planning, standups, and retros
- Track velocity and blockers

### 2. Using the Brain for Ceremonies
- Capture standup notes: "Save this note: Standup 3/25 — Griffin is blocked on OAuth, Rekha found 2 bugs"
- Log retro action items: "Save this action item: Improve error messages in the chat UI"
- Track blockers: "Griffin is blocked on the Salesforce OAuth flow"

### 3. Team Communication
- The brain is the single source of truth for the team
- Encourage everyone to log decisions, blockers, and updates here
`,

    designer: `
## Your Designer Onboarding

### 1. The Chat UI
- Live at: https://team-brain-chat.carrera-328.workers.dev
- The HTML/CSS is in the \`site/\` folder of the repo
- Suggest improvements to the chat experience

### 2. Confluence — Design Docs
- **Space**: https://discoveryacdc.atlassian.net/wiki/spaces/SD
- Document design decisions, wireframes, and style guides
- Create pages: "Create a Confluence page called Design System: Team Brain"

### 3. Jira
- **Board**: https://discoveryacdc.atlassian.net/jira/software/projects/SCRUM/boards/1
- Pick up design-related tickets
- Create issues for UX improvements
`,
  };

  const roleGuide = roleGuides[role] || roleGuides["developer"];

  return common + roleGuide + `
---
*Onboarding logged to the brain. Your teammates can see that you've joined! Ask me anything about the project, tools, or processes.*`;
}
