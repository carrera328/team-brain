/**
 * Team Brain — Chat Worker (Cloudflare Worker)
 *
 * SSE streaming proxy for Claude API with tool use.
 * Tools are auto-discovered from the MCP server — no manual sync needed.
 *
 * Deploy: push to master (GitHub Actions)
 * Secrets: npx wrangler secret put ANTHROPIC_API_KEY
 */

const BASE_SYSTEM_PROMPT = `You are the Shared Brain assistant for an innovation week team. You help the team capture, organize, and retrieve shared knowledge collaboratively.

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

function buildSystemPrompt(user) {
  if (!user || !user.email) return BASE_SYSTEM_PROMPT;
  return `${BASE_SYSTEM_PROMPT}

CURRENT USER:
You are speaking with ${user.name || "a team member"} (${user.email}).
- Role: ${user.role || "member"}
- Team role: ${user.team_role || "developer"}

Always attribute actions (saves, updates) to this user's email. Address them by first name. You know who they are — no need to ask.`;
}

// --- Fetch team members from MCP ---

let cachedTeam = null;
let teamCachedAt = 0;
const TEAM_CACHE_TTL = 60 * 1000; // 1 minute

async function fetchTeam(env) {
  const now = Date.now();
  if (cachedTeam && now - teamCachedAt < TEAM_CACHE_TTL) {
    return cachedTeam;
  }
  try {
    const result = await callMcp("tb_list_users", {}, env);
    const users = JSON.parse(result);
    if (Array.isArray(users)) {
      cachedTeam = users;
      teamCachedAt = now;
      return users;
    }
  } catch (err) {
    console.error("Failed to fetch team:", err);
  }
  return cachedTeam || [];
}

// --- Auth: OAuth Token Verification ---

async function verifyGoogleToken(accessToken) {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.email_verified) return null;
  return { email: data.email.toLowerCase(), name: data.name || data.email };
}

async function verifyMicrosoftToken(accessToken) {
  const res = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const email = (data.mail || data.userPrincipalName || "").toLowerCase();
  if (!email) return null;
  return { email, name: data.displayName || email };
}

// --- Auth: HMAC-Signed Session Tokens ---

async function createSession(user, secret) {
  const payload = JSON.stringify({
    v: 2, // session version — bump to invalidate all old sessions
    email: user.email,
    name: user.name,
    role: user.role,
    team_role: user.team_role,
    exp: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
  });
  const payloadB64 = btoa(unescape(encodeURIComponent(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payloadB64)
  );
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  return payloadB64 + "." + sigB64;
}

async function verifySession(token, secret) {
  try {
    const dotIdx = token.indexOf(".");
    if (dotIdx === -1) return null;
    const payloadB64 = token.substring(0, dotIdx);
    const sigB64 = token.substring(dotIdx + 1);

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const sigBuf = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBuf,
      new TextEncoder().encode(payloadB64)
    );
    if (!valid) return null;

    const payload = JSON.parse(decodeURIComponent(escape(atob(payloadB64))));
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

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

async function executeTool(name, input, env, user) {
  // Inject author for save operations using the authenticated user's email
  const args = { ...input };
  if (name === "tb_save_entry" && user?.email) {
    args.author = user.email;
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

// --- SSE Stream with Tool Use ---

async function streamWithToolUse(messages, writer, encoder, env, user, tools, depth = 0) {
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
      system: buildSystemPrompt(user),
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
      const result = await executeTool(tool.name, tool.input, env, user);
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
    await streamWithToolUse(newMessages, writer, encoder, env, user, tools, depth + 1);
  }
}

// --- Main Handler ---

export default {
  async fetch(request, env) {
    const corsHeaders = getCorsHeaders(request);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ---- Auth endpoints ----

    // GET /auth/config — public OAuth client IDs for the login page
    if (request.method === "GET" && url.pathname === "/auth/config") {
      return new Response(
        JSON.stringify({
          googleClientId: env.GOOGLE_CLIENT_ID || null,
          microsoftClientId: env.MICROSOFT_CLIENT_ID || null,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // POST /auth/verify — exchange OAuth access token for a session
    if (request.method === "POST" && url.pathname === "/auth/verify") {
      try {
        const { provider, token } = await request.json();

        // Verify token with the provider
        let verified = null;
        if (provider === "google") {
          verified = await verifyGoogleToken(token);
        } else if (provider === "microsoft") {
          verified = await verifyMicrosoftToken(token);
        } else {
          return new Response(
            JSON.stringify({ error: "Unsupported provider" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        if (!verified) {
          return new Response(
            JSON.stringify({ error: "Token verification failed" }),
            { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Look up verified email in team roster (D1 via MCP)
        const team = await fetchTeam(env);
        const teamMember = team.find(
          (u) => u.email.toLowerCase() === verified.email
        );

        if (!teamMember) {
          return new Response(
            JSON.stringify({
              error: "Not a team member",
              email: verified.email,
              message: `${verified.email} is not registered in the team. Ask an admin to add you.`,
            }),
            { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Create signed session token
        const session = await createSession(teamMember, env.ANTHROPIC_API_KEY);

        return new Response(
          JSON.stringify({ session, user: teamMember }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (e) {
        console.error("Auth verify error:", e);
        return new Response(
          JSON.stringify({ error: "Authentication failed" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // GET /team — return team members list
    if (request.method === "GET" && url.pathname === "/team") {
      try {
        const team = await fetchTeam(env);
        return new Response(JSON.stringify(team), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (e) {
        console.error("Team fetch error:", e);
        return new Response(JSON.stringify({ error: "Failed to load team" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ---- Chat endpoint (POST /) ----

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    try {
      const body = await request.json();
      const { messages, sessionId } = body;

      // Authenticate: session token in Authorization header (preferred)
      // Falls back to user object in body (for MCP clients / backward compat)
      let user = null;
      const authHeader = request.headers.get("Authorization");
      if (authHeader?.startsWith("Bearer ")) {
        const sessionToken = authHeader.slice(7);
        user = await verifySession(sessionToken, env.ANTHROPIC_API_KEY);
        if (!user) {
          return new Response(
            JSON.stringify({ error: "Session expired. Please sign in again." }),
            { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      } else if (body.user?.email) {
        user = body.user;
      } else if (body.userName) {
        user = { name: body.userName, email: null };
      }

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
      console.log(`Using ${tools.length} tools for user: ${user?.email || "anonymous"}`);

      // Cap conversation length
      const trimmedMessages = messages.slice(-30);

      // Create SSE stream
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      // Process in background
      (async () => {
        try {
          await streamWithToolUse(trimmedMessages, writer, encoder, env, user, tools);
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
