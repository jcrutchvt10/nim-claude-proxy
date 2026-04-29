function stringifyBlockContent(content) {
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") return String(content);
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return JSON.stringify(content);
  }
  if (!Array.isArray(content)) return "";

  return content
    .map(item => {
      if (typeof item?.text === "string") return item.text;
      if (typeof item === "string") return item;
      if (item && typeof item === "object") return JSON.stringify(item);
      return "";
    })
    .join("");
}

function normalizeSystem(system) {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";

  return system
    .map(block => (typeof block?.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n\n");
}

function toTextBlocks(content) {
  if (typeof content === "string") {
    return content.trim().length > 0 ? [content] : [];
  }

  if (!Array.isArray(content)) return [];

  return content
    .map(block => (typeof block?.text === "string" ? block.text : ""))
    .filter(text => text.trim().length > 0);
}

function parseToolUseBlocks(content) {
  if (!Array.isArray(content)) return [];

  return content
    .filter(block => block?.type === "tool_use" && typeof block.name === "string")
    .map(block => ({
      id: block.id || `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: "function",
      function: {
        name: block.name,
        arguments: JSON.stringify(block.input || {})
      }
    }));
}

function parseToolResults(content) {
  if (!Array.isArray(content)) return [];

  return content
    .filter(block => block?.type === "tool_result" && typeof block.tool_use_id === "string")
    .map(block => ({
      role: "tool",
      tool_call_id: block.tool_use_id,
      content: block.is_error === true
        ? JSON.stringify({
          is_error: true,
          content: stringifyBlockContent(block.content)
        })
        : stringifyBlockContent(block.content)
    }));
}

export function toOpenAI(messages = [], system) {
  const out = [];
  const systemText = normalizeSystem(system);
  if (systemText.trim().length > 0) {
    out.push({ role: "system", content: systemText });
  }

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;

    if (message.role === "assistant") {
      const textContent = toTextBlocks(message.content).join("\n\n");
      const toolCalls = parseToolUseBlocks(message.content);
      if (textContent.trim().length > 0 || toolCalls.length > 0) {
        out.push({
          role: "assistant",
          content: textContent,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
        });
      }
      continue;
    }

    if (message.role === "user") {
      const textContent = toTextBlocks(message.content).join("\n\n");
      if (textContent.trim().length > 0) {
        const previous = out[out.length - 1];
        if (previous?.role === "user") {
          previous.content = `${previous.content}\n\n${textContent}`;
        } else {
          out.push({ role: "user", content: textContent });
        }
      }

      const toolResults = parseToolResults(message.content);
      for (const result of toolResults) {
        out.push(result);
      }
      continue;
    }
  }

  return out;
}

export function toOpenAITools(tools = []) {
  if (!Array.isArray(tools)) return [];

  return tools
    .filter(tool => typeof tool?.name === "string")
    .map(tool => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema || { type: "object", properties: {} }
      }
    }));
}

export function toOpenAIToolChoice(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object") return undefined;

  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "none") return "none";
  if (toolChoice.type === "tool" && typeof toolChoice.name === "string") {
    return {
      type: "function",
      function: {
        name: toolChoice.name
      }
    };
  }

  return undefined;
}

export function toClaude(message, model = "nim-proxy", usage = {}, finishReason) {
  const content = [];

  if (typeof message?.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  } else if (Array.isArray(message?.content)) {
    for (const part of message.content) {
      if (typeof part?.text === "string" && part.text.length > 0) {
        content.push({ type: "text", text: part.text });
      }
    }
  }

  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  for (const toolCall of toolCalls) {
    let parsedInput = {};
    try {
      parsedInput = JSON.parse(toolCall?.function?.arguments || "{}");
    } catch {
      parsedInput = {};
    }

    content.push({
      type: "tool_use",
      id: toolCall.id || `toolu_${Date.now()}`,
      name: toolCall?.function?.name || "unknown",
      input: parsedInput
    });
  }

  const resolvedStopReason = toolCalls.length > 0
    ? "tool_use"
    : (finishReason === "length" ? "max_tokens" : "end_turn");

  return {
    id: "msg_" + Date.now(),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: resolvedStopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0
    }
  };
}

export function writeClaudeStream(res, message) {
  const blocks = Array.isArray(message.content) ? message.content : [];
  const textBlocks = blocks.filter(block => block?.type === "text" && typeof block.text === "string");
  const toolUseBlocks = blocks.filter(block => block?.type === "tool_use");

  const startMessage = {
    ...message,
    content: []
  };

  const events = [
    { type: "message_start", message: startMessage },
  ];

  let blockIndex = 0;

  for (const textBlock of textBlocks) {
    events.push({
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "text", text: "" }
    });
    events.push({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "text_delta", text: textBlock.text }
    });
    events.push({ type: "content_block_stop", index: blockIndex });
    blockIndex += 1;
  }

  for (const toolBlock of toolUseBlocks) {
    events.push({
      type: "content_block_start",
      index: blockIndex,
      content_block: {
        type: "tool_use",
        id: toolBlock.id,
        name: toolBlock.name,
        input: {}
      }
    });
    events.push({
      type: "content_block_delta",
      index: blockIndex,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(toolBlock.input || {})
      }
    });
    events.push({ type: "content_block_stop", index: blockIndex });
    blockIndex += 1;
  }

  events.push({
    type: "message_delta",
    delta: {
      stop_reason: message.stop_reason,
      stop_sequence: message.stop_sequence
    },
    usage: { output_tokens: message.usage?.output_tokens ?? 0 }
  });
  events.push({ type: "message_stop" });

  for (const event of events) {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}