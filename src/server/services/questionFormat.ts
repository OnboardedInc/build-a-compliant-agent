// Import-free so the Worker and Node's native TypeScript loader read the same parser.
export type WrittenQuestion = { id: string; question: string; topic: string; listenFor: string };

/**
 * Reads the question writer's seven lines. Blank lines and markdown marks are ignored, and a topic longer than two
 * words is cut to its first two, because the topic is only the label on the score card. A missing field or a question
 * of the wrong length is refused (null), so the caller asks again.
 */
export function parseQuestions(text: string): { jobTitle: string; questions: WrittenQuestion[] } | null {
  const fields = new Map<string, string>();
  for (const raw of text.trim().split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*>\s]+/, "").replace(/\*\*/g, "").replace(/^`+|`+$/g, "").trim();
    if (!line) continue;
    const match = /^(job_title|q[12](?:_topic|_listen_for)?):[ \t]*(.+)$/.exec(line);
    if (!match || fields.has(match[1]!)) return null;
    fields.set(match[1]!, match[2]!.trim());
  }
  const jobTitle = fields.get("job_title");
  if (fields.size !== 7 || !jobTitle) return null;
  const questions: WrittenQuestion[] = [];
  for (const id of ["q1", "q2"]) {
    const question = fields.get(id) || "";
    const words = (fields.get(`${id}_topic`) || "").split(/\s+/).filter(Boolean).slice(0, 2);
    // "Go and Postgres" cut to two words would end on "and".
    if (words.length === 2 && /^(and|or|of|for|with|the|in|on|to|a|an|&)$/i.test(words[1]!)) words.pop();
    const topic = words.join(" ").replace(/[.,;:]+$/, "");
    const listenFor = fields.get(`${id}_listen_for`) || "";
    if (question.length < 10 || question.length > 240 || question.split(/\s+/).length >= 30 || !topic || !listenFor) return null;
    questions.push({ id, question, topic, listenFor });
  }
  return { jobTitle, questions };
}
