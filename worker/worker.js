/**
 * Team Brain — Chat Worker (Cloudflare Worker)
 *
 * SSE streaming proxy for Claude API with tool use.
 * Tools are auto-discovered from the MCP server — no manual sync needed.
 *
 * Deploy: push to master (GitHub Actions)
 * Secrets: npx wrangler secret put ANTHROPIC_API_KEY
 */

const SYSTEM_PROMPT = `You are the Shared Brain assistant for an innovation week team. You help the team capture, organize, and retrieve shared knowledge collaboratively.

IMPORTANT — Salesforce context:
You are connected to our team's Salesforce org (orgfarm-9f4a8cd667-dev-ed.develop.my.salesforce.com). When anyone mentions "Salesforce", "CRM", "accounts", "opportunities", "leads", "contacts", or "deals" — they are referring to THIS org. You have full read/write access including the Tooling API. Don't ask if they want you to check — just do it.

IMPORTANT — GitHub context:
You are connected to the gmarkay/team-brain-sfdc GitHub repo. When anyone asks about PRs, commits, issues, code, or the repo — use the GitHub tools. Don't ask, just search.

CRITICAL BEHAVIOR — Search-first approach:
- When someone mentions ANYTHING that might relate to existing brain content, ALWAYS search first.
- If they say "I finished X" or "X is done" → search for X, find the entry, then update it.
- If they say "X is blocked" or "stuck on X" → search, find it, update status to "blocked" with context.
- If they ask "what's the status of X" → search and report what you find including status.
- Only create a NEW entry if search finds nothing related.

General behavior:
- Be helpful, concise, and collaborative. You're a team member, not just a tool.
- Keep responses SHORT — 2-3 sentences unless more detail is needed.
- When you save something, confirm what you saved and the category.
- When you search, summarize the findings conversationally.
- When you update something, confirm what changed.

About this system:
- This is a demo of MCP (Model Context Protocol) — an open standard that lets AI systems connect to external tools and data.
- The shared brain is powered by an MCP server running on Cloudflare Workers with a D1 database.
- Team members can also connect to the brain from Claude Code, ChatGPT, Cursor, or any MCP-compatible client.
- This chat interface is one way to interact with the brain — but the same data is accessible from any connected tool.

Do NOT:
- Give long-winded explanations unless asked
- Repeat the user's question back to them
- Be overly formal — this is a team collaboration tool
- Create new entries when you should be updating existing ones`;

// --- MCP Tool Discovery ---
// Fetch tools from the MCP server once, then cache in memory.

let cachedTools = null;
let toolsCachedAt = 0;
const TOOLS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function discoverTools(env) {
  const now = Date.now();
  if (cachedTools && now - toolsCachedAt < TOOLS_CACHE_TTL) {
    return cachedTools;
  }

  try {
    const response = await env.MCP.fetch("https://mcp/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });

    if (!response.ok) {
      console.error("MCP tools/list error:", response.status);
      return cachedTools || []; // fall back to stale cache
    }

    const result = await response.json();
    const mcpTools = result.result?.tools || [];

    // Convert MCP tool format to Anthropic tool format
    const anthropicTools = mcpTools.map((tool) => ({
      name: tool.name,
      description: tool.description || "",
      input_schema: tool.inputSchema || { type: "object", properties: {} },
    }));

    cachedTools = anthropicTools;
    toolsCachedAt = now;
    console.log(`Discovered ${anthropicTools.length} tools from MCP server`);
    return anthropicTools;
  } catch (err) {
    console.error("Tool discovery error:", err.message);
    return cachedTools || []; // fall back to stale cache
  }
}

// --- MCP Client ---

async function callMcp(toolName, args, env) {
  try {
    const response = await env.MCP.fetch("https://mcp/mcp", {
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

    if (!response.ok) {
      const errText = await response.text();
      console.error("MCP HTTP error:", response.status, errText);
      return JSON.stringify({ error: `MCP returned ${response.status}` });
    }

    const result = await response.json();
    if (result.result?.content?.[0]?.text) {
      return result.result.content[0].text;
    }
    return JSON.stringify(result.result || result.error || { error: "MCP call failed" });
  } catch (err) {
    console.error("MCP fetch error:", err.message || err);
    return JSON.stringify({ error: "Failed to reach MCP server", detail: err.message });
  }
}

async function executeTool(name, input, env, userName) {
  // Inject author for save operations
  const args = { ...input };
  if (name === "tb_save_entry" && userName) {
    args.author = userName;
  }

  return await callMcp(name, args, env);
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

async function streamWithToolUse(messages, writer, encoder, env, userName, tools, depth = 0) {
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
      tools,
      stream: true,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("Anthropic API error:", response.status, errText);
    let userMessage = "I ran into an issue processing that request.";
    if (response.status === 429) {
      userMessage = "I'm getting too many requests right now — give me a moment and try again.";
    } else if (response.status === 413 || errText.includes("too many tokens")) {
      userMessage = "That request was too large for me to process. Try asking something more specific or starting a new conversation.";
    } else if (response.status === 401) {
      userMessage = "There's an authentication issue with the AI service. Let the team know so they can check the API key.";
    } else if (response.status === 400) {
      userMessage = `I had trouble with that request: ${errText.substring(0, 200)}. Could you rephrase it?`;
    } else if (response.status === 500 || response.status === 502 || response.status === 503) {
      userMessage = "The AI service is having issues right now. Try again in a few seconds.";
    } else {
      userMessage = `Something went wrong (error ${response.status}). Could you try rephrasing your question?`;
    }
    console.error("Sending user-friendly error:", userMessage);
    await writer.write(
      encoder.encode(
        `data: ${JSON.stringify({ type: "error", message: userMessage })}\n\n`
      )
    );
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let fullContent = [];
  let toolUseBlocks = [];
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
    await writer.write(
      encoder.encode(
        `data: ${JSON.stringify({ type: "brain_activity", message: "Accessing shared brain..." })}\n\n`
      )
    );

    const toolResults = [];
    for (const tool of toolUseBlocks) {
      console.log("Calling MCP tool:", tool.name, JSON.stringify(tool.input));
      const result = await executeTool(tool.name, tool.input, env, userName);
      console.log("MCP result length:", result?.length, "preview:", result?.substring(0, 200));
      toolResults.push({
        type: "tool_result",
        tool_use_id: tool.id,
        content: result,
      });
    }

    const newMessages = [
      ...messages,
      { role: "assistant", content: fullContent },
      { role: "user", content: toolResults },
    ];

    console.log("Recursing with tool results, depth:", depth + 1);
    await streamWithToolUse(newMessages, writer, encoder, env, userName, tools, depth + 1);
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

      // Discover tools from MCP server (cached)
      const tools = await discoverTools(env);
      console.log(`Using ${tools.length} tools`);

      // Cap conversation length
      const trimmedMessages = messages.slice(-30);

      // Create SSE stream
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      // Process in background
      (async () => {
        try {
          await streamWithToolUse(trimmedMessages, writer, encoder, env, userName, tools);
          await writer.write(
            encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`)
          );
          await writer.close();
        } catch (e) {
          console.error("Stream error:", e);
          const errMsg = e?.message || String(e);
          let userMessage = "Something unexpected happened. Could you try again or rephrase your question?";
          if (errMsg.includes("tool") || errMsg.includes("MCP")) {
            userMessage = `I had trouble using one of my tools: ${errMsg}. Could you try rephrasing what you need?`;
          }
          try {
            await writer.write(
              encoder.encode(
                `data: ${JSON.stringify({ type: "error", message: userMessage })}\n\n`
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
