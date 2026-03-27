# Team Brain — Project Guidance

## What is this?
Team Brain is a shared MCP (Model Context Protocol) server + chat interface built for Innovation Week at Thrivent by The Catalyst Crew.

## Architecture
- **worker/** — Cloudflare Worker that serves the chat UI and proxies to Claude API + MCP
- **worker-mcp/** — Cloudflare Worker that runs the MCP server (Streamable HTTP transport)
- **migration.sql** — D1 database schema
- **seed-team.sql** — Seeds team members into the database

## Connected Services
- **D1 Database** — Shared brain (notes, ideas, decisions, action items)
- **Jira** — discoveryacdc.atlassian.net (project: SCRUM)
- **Confluence** — discoveryacdc.atlassian.net/wiki (space: SD)
- **Salesforce** — orgfarm-9f4a8cd667-dev-ed.develop.my.salesforce.com
- **GitHub** — gmarkay/team-brain-sfdc

## Team (The Catalyst Crew)
1. Sal Carrera (carrera.328@gmail.com) — admin, developer
2. Griffin Markay (gmarkay@outlook.com) — member, developer
3. Venkata Gorrepati (venkivenki8697@gmail.com) — member, developer
4. Rekha Gorrepati (rekha.g@outlook.com) — member, qa
5. Perry Golas (ptgolas@hotmail.com) — member, product_owner

## Deploying
**ALWAYS push to master for deployment.** Never use `wrangler deploy` or `wrangler pages deploy` directly.
Push to master — GitHub Actions auto-deploys both workers and the site to Cloudflare.

## Local Dev
```bash
cd worker && npx wrangler dev
cd worker-mcp && npx wrangler dev
```

## Secrets (set via wrangler secret put)
- ANTHROPIC_API_KEY
- JIRA_API_TOKEN
- CONFLUENCE_API_TOKEN
- SF_CLIENT_ID
- SF_CLIENT_SECRET
- GITHUB_TOKEN
