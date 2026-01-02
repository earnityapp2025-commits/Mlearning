/**
 * OpenAI client used by MLearning
 * Read-only analysis layer
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is missing in MLearning env");
}

export async function analyzeEvent({ summary, context }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You are an expert software architect. Analyze events and return concise, actionable insights.",
        },
        {
          role: "user",
          content: `
Event summary:
${summary}

Context (JSON):
${JSON.stringify(context, null, 2)}
`,
        },
      ],
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data?.error?.message || "OpenAI request failed");
  }

  return data.choices[0].message.content.trim();
}
