import { Tool } from '@modelcontextprotocol/sdk/types.js';

// Collection of programming and tech jokes
const jokes = [
  "Why do programmers prefer dark mode? Because light attracts bugs!",
  "How many programmers does it take to change a light bulb? None. That's a hardware problem.",
  "Why don't programmers like nature? It has too many bugs.",
  "What's a programmer's favorite hangout place? Foo Bar.",
  "Why did the programmer quit his job? He didn't get arrays.",
  "How do you comfort a JavaScript bug? You console it.",
  "What do you call a programmer from Finland? Nerdic.",
  "Why do Java developers wear glasses? Because they can't C#.",
  "What's the object-oriented way to become wealthy? Inheritance.",
  "Why did the developer go broke? Because he used up all his cache.",
  "What do you call a sleeping bull at a computer company? A bulldozer.",
  "Why don't programmers like to go outside? The sun gives them arrays.",
  "What's a computer's favorite snack? Microchips.",
  "Why was the JavaScript developer sad? Because he didn't Node how to Express himself.",
  "What do you call a programmer who doesn't comment their code? A developer of mystery."
];

export const jokeTool: Tool = {
  name: 'tell_joke',
  description: 'Tell a random programming or tech joke to lighten the mood',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false
  }
};

export function handleTellJoke(): string {
  const randomIndex = Math.floor(Math.random() * jokes.length);
  return jokes[randomIndex];
}