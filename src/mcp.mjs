import { connectControl } from "./broker.mjs";
import { errorObject } from "./protocol.mjs";

const TOOLS = [
  {
    name: "partyline_register",
    description: "Register this coding-agent session in the local Partyline broker.",
    inputSchema: {
      type: "object",
      properties: {
        alias: { type: "string", description: "Stable local name for this agent session." },
        kind: { type: "string", description: "Agent kind, for example codex, claude, kimi, or pi." },
        session: { type: "string", description: "Optional provider session identifier." }
      },
      required: ["alias"]
    }
  },
  {
    name: "partyline_list",
    description: "List locally connected agent sessions and explicit pairings.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "partyline_pair",
    description: "Create an explicit bidirectional consent edge between two local agent sessions.",
    inputSchema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"]
    }
  },
  {
    name: "partyline_unpair",
    description: "Remove an explicit pairing between two local agent sessions.",
    inputSchema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"]
    }
  },
  {
    name: "partyline_send",
    description: "Send bounded text to a paired local agent mailbox. Delivery does not mean the model read or acted on it.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        text: { type: "string" },
        conversation_id: { type: "string" },
        reply_to: { type: "string" },
        expects_reply: { type: "boolean" },
        ttl_ms: { type: "integer", minimum: 1, maximum: 86400000 }
      },
      required: ["to", "text"]
    }
  },
  {
    name: "partyline_await",
    description: "Wait for one message in this agent's local mailbox.",
    inputSchema: {
      type: "object",
      properties: {
        alias: { type: "string" },
        timeout_ms: { type: "integer", minimum: 1, maximum: 60000 }
      }
    }
  },
  {
    name: "partyline_status",
    description: "Read delivery metadata for a message without exposing its body.",
    inputSchema: {
      type: "object",
      properties: { message_id: { type: "string" } },
      required: ["message_id"]
    }
  }
];

const METHOD_BY_TOOL = new Map([
  ["partyline_register", "register"],
  ["partyline_list", "list"],
  ["partyline_pair", "pair"],
  ["partyline_unpair", "unpair"],
  ["partyline_send", "send"],
  ["partyline_await", "await"],
  ["partyline_status", "status"]
]);

function result(value, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text: JSON.stringify(value) }]
  };
}

export async function runMcp({ socketPath, name, kind = "unknown", session = null }) {
  const client = await connectControl(socketPath);
  let selfName = name ?? null;
  try {
    if (selfName) await client.request("register", { alias: selfName, kind, session });
    let pending = "";
    for await (const chunk of process.stdin) {
      pending += chunk.toString("utf8");
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const raw = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (!raw.trim()) continue;
        let request;
        try {
          request = JSON.parse(raw);
          const response = await handleMcpRequest(client, request, () => selfName, (value) => { selfName = value; });
          if (request.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: response })}\n`);
        } catch (error) {
          if (request?.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: errorObject(error).message, data: errorObject(error) } })}\n`);
        }
      }
    }
  } finally {
    client.close();
  }
}

async function handleMcpRequest(client, request, getSelfName, setSelfName) {
  if (request?.method === "notifications/initialized" || request?.method === "notifications/cancelled") return undefined;
  if (request?.method === "initialize") {
    return {
      protocolVersion: typeof request.params?.protocolVersion === "string" ? request.params.protocolVersion : "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "partyline", version: "0.1.0" }
    };
  }
  if (request?.method === "tools/list") return { tools: TOOLS };
  if (request?.method !== "tools/call") throw new Error(`Unsupported MCP method: ${request?.method}`);

  const toolName = request.params?.name;
  const method = METHOD_BY_TOOL.get(toolName);
  if (!method) return result({ code: "method_not_found", message: `Unknown tool: ${toolName}` }, true);

  const argumentsValue = { ...(request.params?.arguments ?? {}) };
  const selfName = getSelfName();
  if ((method === "send" || method === "await") && !argumentsValue.alias && !argumentsValue.from && selfName) {
    if (method === "send") argumentsValue.from = selfName;
    else argumentsValue.alias = selfName;
  }
  try {
    const value = await client.request(method, argumentsValue);
    if (method === "register") setSelfName(argumentsValue.alias);
    return result(value);
  } catch (error) {
    return result(errorObject(error), true);
  }
}
