import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const JOKES = [
  { setup: "Why do programmers prefer dark mode?", punchline: "Because light attracts bugs!" },
  { setup: "How many programmers does it take to change a light bulb?", punchline: "None. That's a hardware problem." },
  { setup: "Why did the developer go broke?", punchline: "Because he used up all his cache!" },
  { setup: "What's a programmer's favorite hangout place?", punchline: "Foo Bar!" },
  { setup: "Why do Java developers wear glasses?", punchline: "Because they can't C#!" },
  { setup: "Why was the JavaScript developer sad?", punchline: "Because they didn't Node how to Express themselves!" },
  { setup: "How do you comfort a JavaScript bug?", punchline: "You console it!" },
  { setup: "Why did the programmer quit their job?", punchline: "They didn't get arrays!" },
  { setup: "What's the object-oriented way to become wealthy?", punchline: "Inheritance!" },
  { setup: "Why do programmers hate nature?", punchline: "It has too many bugs!" },
];

export function registerJokeTools(server: McpServer) {
  server.registerTool(
    "tell_joke",
    {
      title: "Tell a Joke",
      description: "Tell a random programming joke to brighten the team's day.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async () => {
      const joke = JOKES[Math.floor(Math.random() * JOKES.length)];
      return {
        content: [{ type: "text" as const, text: `${joke.setup}\n\n${joke.punchline}` }],
      };
    }
  );
}
