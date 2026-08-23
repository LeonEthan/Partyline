#!/usr/bin/env node
import fs from "node:fs/promises";
import process from "node:process";
import { connectControl, defaultSocketPath, startBrokerServer } from "../src/broker.mjs";
import { runMcp } from "../src/mcp.mjs";
import { runRpc } from "../src/rpc.mjs";
import { errorObject } from "../src/protocol.mjs";

function flags(argv) {
  const values = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const equal = arg.indexOf("=");
    if (equal !== -1) {
      values[arg.slice(2, equal)] = arg.slice(equal + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values[key] = next;
      index += 1;
    } else {
      values[key] = true;
    }
  }
  return { values, positional };
}

function socketOption(options) {
  return options.socket || defaultSocketPath();
}

async function withOperator(socketPath, action) {
  const client = await connectControl(socketPath);
  try {
    await client.request("hello", { role: "operator" });
    return await action(client);
  } finally {
    client.close();
  }
}

async function readMessage(positional, options) {
  if (options.message !== undefined) return String(options.message);
  if (positional.length) return positional.join(" ");
  if (process.stdin.isTTY) throw new Error("send requires --message, text, or piped stdin");
  return (await fs.readFile(0, "utf8")).trimEnd();
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help() {
  process.stdout.write(`Partyline local agent mailbox\n\nCommands:\n  partyline serve [--socket PATH]\n  partyline mcp --name ALIAS --kind KIND [--socket PATH]\n  partyline rpc --name ALIAS --kind KIND [--socket PATH]\n  partyline register --name ALIAS [--kind KIND] [--session ID]\n  partyline list\n  partyline pair --from A --to B\n  partyline unpair --from A --to B\n  partyline send --from A --to B --message TEXT\n  partyline await --name ALIAS [--timeout MS]\n  partyline status --message ID\n  partyline stop\n`);
}

async function main() {
  const command = process.argv[2] || "help";
  const { values, positional } = flags(process.argv.slice(3));
  const socketPath = socketOption(values);

  if (command === "help" || command === "--help") return help();
  if (command === "serve") {
    const running = await startBrokerServer({ socketPath });
    process.stderr.write(`Partyline listening on ${running.socketPath}\n`);
    const shutdown = async () => {
      await running.close();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    await new Promise((resolve) => running.server.once("close", resolve));
    return;
  }
  if (command === "mcp") return runMcp({ socketPath, name: values.name, kind: values.kind, session: values.session });
  if (command === "rpc") return runRpc({ socketPath, name: values.name, kind: values.kind, session: values.session });

  const result = await withOperator(socketPath, async (client) => {
    switch (command) {
      case "register":
        return client.request("register", { alias: values.name, kind: values.kind || "operator", session: values.session || null, persistent: true });
      case "list":
        return client.request("list");
      case "pair":
        return client.request("pair", { from: values.from, to: values.to });
      case "unpair":
        return client.request("unpair", { from: values.from, to: values.to });
      case "send":
        return client.request("send", { from: values.from, to: values.to, text: await readMessage(positional, values), conversation_id: values["conversation-id"], reply_to: values["reply-to"], expects_reply: Boolean(values["expects-reply"]), ttl_ms: values.ttl ? Number(values.ttl) : undefined });
      case "await":
        return client.request("await", { alias: values.name, timeout_ms: values.timeout ? Number(values.timeout) : 30000 });
      case "status":
        return client.request("status", { message_id: values.message });
      case "stop":
        return client.request("shutdown");
      default:
        return help();
    }
  });
  if (result !== undefined) print(result);
}

try {
  await main();
} catch (error) {
  const safe = errorObject(error);
  process.stderr.write(`${safe.code}: ${safe.message}\n`);
  process.exitCode = 1;
}
