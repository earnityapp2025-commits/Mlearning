const text = data.choices[0].message.content.trim();

// VERY simple tag extraction (safe + deterministic)
const tags = [];

if (/error|fail|exception/i.test(text)) tags.push("error");
if (/success|working|ok/i.test(text)) tags.push("success");
if (/database|sql|supabase/i.test(text)) tags.push("database");
if (/auth|token|permission/i.test(text)) tags.push("auth");
if (/ui|panel|frontend/i.test(text)) tags.push("ui");

return {
  insight: text,
  auto_tags: tags,
};