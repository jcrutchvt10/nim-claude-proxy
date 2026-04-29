function flattenContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map(block => {
      if (!block || typeof block !== "object") return "";

      if (typeof block.text === "string") return block.text;

      if (block.type === "tool_result") {
        if (typeof block.content === "string") return block.content;
        if (Array.isArray(block.content)) {
          return block.content
            .map(item => (typeof item?.text === "string" ? item.text : ""))
            .join("");
        }
      }

      return "";
    })
    .join("");
}

export function toOpenAI(messages = [], system) {
  const out = [];
  if (typeof system === "string" && system.trim().length > 0) {
    out.push({ role: "system", content: system });
  }

  for (const m of messages) {
    const content = flattenContent(m?.content);
    if (typeof content !== "string" || content.trim().length === 0) {
      continue;
    }

    out.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content
    });
  }
  return out;
}

export function toClaude(text, model = "nim-proxy", usage = {}) {
  return {
    id: "msg_" + Date.now(),
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0
    }
  };
}

export function writeClaudeStream(res, message) {
  const text = message.content?.[0]?.text || "";

  const startMessage = {
    ...message,
    content: []
  };

  const events = [
    { type: "message_start", message: startMessage },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" }
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text }
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: {
        stop_reason: message.stop_reason,
        stop_sequence: message.stop_sequence
      },
      usage: { output_tokens: message.usage?.output_tokens ?? 0 }
    },
    { type: "message_stop" }
  ];

  for (const event of events) {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}