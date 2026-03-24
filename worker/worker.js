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
- Provide a summary/dashboard of everything stored

Behavior:
- When someone shares an idea, decision, or important information, proactively offer to save it to the shared brain using the save_to_brain tool.
- When someone asks a question that might be answered by existing knowledge, search the brain first using search_brain.
- When asked what's in the brain or for an overview, use get_brain_summary.
- Be helpful, concise, and collaborative. You're a team member, not just a tool.
- Keep responses SHORT — 2-3 sentences unless more detail is needed.
- When you save something, confirm what you saved and the category.
- When you search, summarize the findings conversationally.

About this system:
- This is a demo of MCP (Model Context Protocol) — an open standard that lets AI systems connect to external tools and data.
- The shared brain is powered by an MCP server running on Cloudflare Workers with a D1 database.
- Team members can also connect to the brain from Claude Code, Cursor, or any MCP-compatible client.
- This chat interface is one way to interact with the brain — but the same data is accessible from any connected tool.

Do NOT:
- Give long-winded explanations unless asked
- Repeat the user's question back to them
- Be overly formal — this is a team collaboration tool`;

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
];

// --- MCP Client ---
// All tool calls go through the MCP server — single source of truth.

const MCP_URL = "https://team-brain-mcp.carrera-328.workers.dev/mcp";

const TOOL_NAME_MAP = {
  save_to_brain: "tb_save_entry",
  search_brain: "tb_search_entries",
  get_brain_summary: "tb_dashboard",
};

async function callMcp(toolName, args) {
  const response = await fetch(MCP_URL, {
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

  const result = await response.json();
  if (result.result?.content?.[0]?.text) {
    return result.result.content[0].text;
  }
  return JSON.stringify(result.result || result.error || { error: "MCP call failed" });
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

  return await callMcp(mcpName, args);
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
    await writer.write(
      encoder.encode(
        `data: ${JSON.stringify({ type: "error", message: "AI service temporarily unavailable" })}\n\n`
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
      const result = await executeTool(tool.name, tool.input, env, userName);
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
          try {
            await writer.write(
              encoder.encode(
                `data: ${JSON.stringify({ type: "error", message: "Something went wrong" })}\n\n`
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
