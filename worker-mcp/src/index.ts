import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { setupTeamBrainTools } from './tools/team-brain.js';
import { setupJiraTools } from './tools/jira.js';
import { setupConfluenceTools } from './tools/confluence.js';
import { setupGitHubTools } from './tools/github.js';
import { setupSalesforceTools } from './tools/salesforce.js';
import { setupJokeTools } from './tools/joke.js';

export interface Env {
  TEAM_BRAIN_DB: D1Database;
  JIRA_HOST?: string;
  JIRA_EMAIL?: string;  
  JIRA_API_TOKEN?: string;
  CONFLUENCE_HOST?: string;
  CONFLUENCE_EMAIL?: string;
  CONFLUENCE_API_TOKEN?: string;
  GITHUB_TOKEN?: string;
  GITHUB_OWNER?: string;
  GITHUB_REPO?: string;
  SALESFORCE_INSTANCE_URL?: string;
  SALESFORCE_ACCESS_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    if (request.method === 'GET' && new URL(request.url).pathname === '/') {
      return new Response('MCP Server is running', {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'text/plain',
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { 
        status: 405,
        headers: {
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    try {
      const server = new Server(
        {
          name: 'team-brain-mcp',
          version: '1.0.0',
        },
        {
          capabilities: {
            tools: {},
          },
        }
      );

      // Auto-migrate database
      try {
        await env.TEAM_BRAIN_DB.exec(`
          ALTER TABLE brain_entries ADD COLUMN team_role TEXT;
        `);
      } catch (e) {
        // Column already exists, ignore
      }

      // Register tools conditionally based on environment
      setupTeamBrainTools(server, env.TEAM_BRAIN_DB);
      
      if (env.JIRA_HOST && env.JIRA_EMAIL && env.JIRA_API_TOKEN) {
        setupJiraTools(server, env);
      }
      
      if (env.CONFLUENCE_HOST && env.CONFLUENCE_EMAIL && env.CONFLUENCE_API_TOKEN) {
        setupConfluenceTools(server, env);
      }
      
      if (env.GITHUB_TOKEN && env.GITHUB_OWNER && env.GITHUB_REPO) {
        setupGitHubTools(server, env);
      }
      
      if (env.SALESFORCE_INSTANCE_URL && env.SALESFORCE_ACCESS_TOKEN) {
        setupSalesforceTools(server, env);
      }

      // Always register joke tool - no external dependencies
      setupJokeTools(server);

      server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
          tools: server.listTools(),
        };
      });

      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        return await server.callTool(name, args || {});
      });

      const transport = new StdioServerTransport();
      const body = await request.text();
      
      // Parse the JSON-RPC request
      const jsonRpcRequest = JSON.parse(body);
      
      // Handle the request through the server
      let result;
      if (jsonRpcRequest.method === 'tools/list') {
        result = await server.request(
          { method: 'tools/list', params: {} },
          { meta: {} }
        );
      } else if (jsonRpcRequest.method === 'tools/call') {
        result = await server.request(
          { method: 'tools/call', params: jsonRpcRequest.params },
          { meta: {} }
        );
      } else {
        throw new Error(`Unknown method: ${jsonRpcRequest.method}`);
      }

      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: jsonRpcRequest.id,
        result: result,
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (error) {
      console.error('Error:', error);
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32603,
          message: 'Internal error',
          data: error instanceof Error ? error.message : 'Unknown error',
        },
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  },
};