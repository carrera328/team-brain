import { Tool } from '@modelcontextprotocol/sdk/types.js';

// Collection of programming and team-related jokes
const JOKES = [
  {
    setup: "Why do programmers prefer dark mode?",
    punchline: "Because light attracts bugs!"
  },
  {
    setup: "How many programmers does it take to change a light bulb?",
    punchline: "None. That's a hardware problem."
  },
  {
    setup: "Why did the developer go broke?",
    punchline: "Because he used up all his cache!"
  },
  {
    setup: "What's a programmer's favorite hangout place?",
    punchline: "Foo Bar!"
  },
  {
    setup: "Why do Java developers wear glasses?",
    punchline: "Because they can't C#!"
  },
  {
    setup: "What did the developer say when they couldn't find their keys?",
    punchline: "404: Keys not found!"
  },
  {
    setup: "Why was the JavaScript developer sad?",
    punchline: "Because they didn't Node how to Express themselves!"
  },
  {
    setup: "How do you comfort a JavaScript bug?",
    punchline: "You console it!"
  },
  {
    setup: "Why did the programmer quit their job?",
    punchline: "They didn't get arrays!"
  },
  {
    setup: "What's the object-oriented way to become wealthy?",
    punchline: "Inheritance!"
  },
  {
    setup: "Why do programmers hate nature?",
    punchline: "It has too many bugs!"
  },
  {
    setup: "What do you call a programmer from Finland?",
    punchline: "Nerdic!"
  },
  {
    setup: "Why did the developer break up with CSS?",
    punchline: "There was no class!"
  },
  {
    setup: "What's a developer's favorite type of music?",
    punchline: "algo-rhythm!"
  },
  {
    setup: "Why was the function feeling lonely?",
    punchline: "Because it had no parameters!"
  }
];

export const jokeTool: Tool = {
  name: 'tell_joke',
  description: 'Tell a random programming or tech joke to brighten the team\'s day. Perfect for breaking tension during standups or celebrating deployments!',
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        description: 'Optional joke category (currently only "programming" is supported)',
        enum: ['programming'],
        default: 'programming'
      }
    }
  }
};

export async function handleJoke(args: any) {
  // Pick a random joke from the collection
  const randomJoke = JOKES[Math.floor(Math.random() * JOKES.length)];
  
  return {
    content: [
      {
        type: "text",
        text: `${randomJoke.setup}\n\n${randomJoke.punchline} 😄`
      }
    ]
  };
}