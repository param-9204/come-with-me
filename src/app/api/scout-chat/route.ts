import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SAVED_PLACES = [
  "Sushi Nakazawa (West Village, Omakase restaurant, ★4.9)",
  "Raoul's (SoHo, French bistro, ★4.7)",
  "Blank Street Coffee (Williamsburg, Coffee, ★4.5)",
  "The Bar at Bemelmans (Upper East Side, Bar, ★4.8)",
  "McNally Jackson (Nolita, Bookshop, ★4.6)",
  "Joe Coffee (West Village, Coffee, ★4.4)",
];

const SYSTEM_PROMPT = `You are Ruby, a warm and knowledgeable personal city insider for Ruby – Find Hidden Gems. You know the user's saved places in NYC: ${SAVED_PLACES.join(", ")}. Be specific, fun, and under 100 words per response. Reference their saved places when relevant.`;

export async function POST(req: NextRequest) {
  const { messages } = await req.json();

  if (!messages || !Array.isArray(messages)) {
    return NextResponse.json({ error: "No messages" }, { status: 400 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({
      reply: "Hey! I'm Ruby 🧭 I can see you've saved some amazing spots — Sushi Nakazawa, Bemelmans, Raoul's. Ask me anything about your saved places or what to do in NYC tonight!",
    });
  }

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 200,
    system: SYSTEM_PROMPT,
    messages: messages.map((m: { role: string; content: string }) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  });

  const reply = response.content[0].type === "text" ? response.content[0].text : "Sorry, I couldn't think of anything!";

  return NextResponse.json({ reply });
}
