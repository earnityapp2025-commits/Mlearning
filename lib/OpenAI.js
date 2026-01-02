/**
 * Minimal OpenAI helper for MLearning
 * - Uses fetch
 * - Throws useful errors
 * - Returns plain text output
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is missing in env");
}

export async function askOpenAI({ system, user, model = "gpt-4o-mini" }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: user },
      ],
      temperature: 0.2,
    }),
  });

  const data = await res.json();

  // If API error, show message clearly
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }

  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI returned no message content");

  return text.trim();
}
