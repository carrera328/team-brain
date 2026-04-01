import McpServer from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const GREETINGS = [
  { language: "English", greeting: "Hi team!" },
  { language: "Spanish", greeting: "¡Hola equipo!" },
  { language: "French", greeting: "Salut l'équipe !" },
  { language: "German", greeting: "Hallo Team!" },
  { language: "Italian", greeting: "Ciao squadra!" },
  { language: "Portuguese", greeting: "Olá, equipe!" },
  { language: "Japanese", greeting: "チームのみなさん、こんにちは！" },
  { language: "Korean", greeting: "팀 여러분, 안녕하세요!" },
  { language: "Hindi", greeting: "नमस्ते टीम!" },
  { language: "Swahili", greeting: "Habari timu!" }
] as const;

export function register(server: McpServer) {
  server.registerTool(
    "say_hi_to_team",
    {
      title: "Say Hi To Team",
      description: "Randomly says hi to the team in a different language.",
      inputSchema: {
        includeLanguage: z.boolean().optional().describe("Whether to include the language name in the response")
      }
    },
    async ({ includeLanguage = true }) => {
      const choice = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
      const text = includeLanguage
        ? `${choice.greeting} (${choice.language})`
        : choice.greeting;

      return {
        content: [
          {
            type: "text",
            text
          }
        ]
      };
    }
  );
}

import { register as registerSayHiToTeam } from "./tools/say_hi_to_team";
registerSayHiToTeam(server);
