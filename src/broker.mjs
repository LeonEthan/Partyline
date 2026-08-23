import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import net from "node:net";
import { PartylineError, MAX_AWAIT_MS, MAX_QUEUE_LENGTH, assertAlias, assertString, errorObject, frame, isExpired, messageEnvelope, publicMessage, lineParser } from "./protocol.mjs";

export function defaultStateDir() {
  return process.env.PARTYLINE_STATE_DIR || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "partyline");
}

export function defaultSocketPath() {
  return process.env.PARTYLINE_SOCKET || path.join(defaultStateDir(), "partyline.sock");
}

function pairKey(a, b) {
  return [a, b].sort().join("\u0000");
}

function routeView(route, pairs) {
  return {
    alias: route.alias,
    kind: route.kind,
    session: route.session ?? null,
    connected: Boolean(route.client?.socket?.writable),
    persistent: route.persistent,
    queued: route.queue.length,
    paired_with: [...pairs]
      .filter((key) => key.includes(`\u0000${route.alias}`) || key.startsWith(`${route.alias}\u0000`))
      .map((key) => key.split("\u0000").find((name) => name !== route.alias))
      .filter(Boolean),
    registered_at: route.registeredAt
  };
}

export class PartylineBroker {
  constructor({ maxQueueLength = MAX_QUEUE_LENGTH, maxHistory = 1000 } = {}) {
    this.routes = new Map();
    this.pairs = new Set();
    this.messages = new Map();
    this.maxQueueLength = maxQueueLength;
    this.maxHistory = maxHistory;
  }

  register({ alias, kind = "unknown", session = null }, client = null) {
    assertAlias(alias);
    assertString(kind, "kind", { maxBytes: 64 });
    if (session !== null && session !== undefined) assertString(session, "session", { maxBytes: 256 });

    const existing = this.routes.get(alias);
    if (existing && existing.client !== client) {
      throw new PartylineError("route_exists", `Route ${alias} is already connected`);
    }
    const route = existing ?? {
      alias,
      queue: [],
      waiters: new Set(),
      registeredAt: new Date().toISOString(),
      client,
      persistent: client === null
    };
    route.kind = kind;
    route.session = session;
    route.client = client;
    route.persistent = client === null;
    this.routes.set(alias, route);
    if (client) client.alias = alias;
    return routeView(route, this.pairs);
  }

  unregisterClient(client) {
    if (!client) return;
    for (const [alias, route] of this.routes) {
      if (route.client !== client) continue;
      this.unregisterRoute(alias);
    }
  }

  unregisterRoute(alias) {
    const route = this.requireRoute(alias);
    for (const message of route.queue) {
      const record = this.messages.get(message.message_id);
      if (record) {
        record.state = "cancelled";
        record.updatedAt = new Date().toISOString();
      }
    }
    route.queue.length = 0;
    for (const waiter of route.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    route.waiters.clear();
    this.routes.delete(alias);
    for (const key of [...this.pairs]) {
      if (key.split("\u0000").includes(alias)) this.pairs.delete(key);
    }
  }

  list() {
    return {
      version: 1,
      routes: [...this.routes.values()].map((route) => routeView(route, this.pairs)),
      pairs: [...this.pairs].map((key) => key.split("\u0000"))
    };
  }

  pair({ from, to }, caller = "operator") {
    assertAlias(from, "from");
    assertAlias(to, "to");
    if (from === to) throw new PartylineError("invalid_request", "A route cannot pair with itself");
    this.requireRoute(from);
    this.requireRoute(to);
    this.requireCaller(caller, from);
    this.pairs.add(pairKey(from, to));
    return { from, to, paired: true };
  }

  unpair({ from, to }, caller = "operator") {
    assertAlias(from, "from");
    assertAlias(to, "to");
    this.requireCaller(caller, from);
    this.pairs.delete(pairKey(from, to));
    return { from, to, paired: false };
  }

  send(params, caller = "operator") {
    const { from, to, text, conversation_id: conversationId, reply_to: replyTo, expects_reply: expectsReply, ttl_ms: ttlMs } = params;
    assertAlias(from, "from");
    assertAlias(to, "to");
    this.requireCaller(caller, from);
    this.requireRoute(from);
    const target = this.requireRoute(to);
    if (!this.pairs.has(pairKey(from, to))) {
      throw new PartylineError("not_paired", `Routes ${from} and ${to} are not paired`);
    }
    this.prune(target);
    if (target.queue.length >= this.maxQueueLength && target.waiters.size === 0) {
      throw new PartylineError("queue_full", `Route ${to} mailbox is full`);
    }

    const message = messageEnvelope({ from, to, text, conversationId, replyTo, expectsReply, ttlMs });
    const waiter = target.waiters.values().next().value;
    const deliveryState = waiter ? "delivered" : "queued";
    target.queue.push(message);
    this.messages.set(message.message_id, { message, state: deliveryState, updatedAt: new Date().toISOString() });
    this.trimHistory();

    if (waiter) {
      target.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      const next = target.queue.shift();
      waiter.resolve(this.consume(next));
    }

    return publicMessage(message, deliveryState);
  }

  async awaitMessage({ alias, timeout_ms: timeoutMs = 30000 }, caller = alias) {
    assertAlias(alias);
    this.requireCaller(caller, alias);
    const route = this.requireRoute(alias);
    this.prune(route);
    if (route.queue.length) return this.consume(route.queue.shift());

    const timeout = Math.min(Math.max(Number(timeoutMs) || 30000, 1), MAX_AWAIT_MS);
    return new Promise((resolve) => {
      const waiter = {
        timer: setTimeout(() => {
          route.waiters.delete(waiter);
          resolve(null);
        }, timeout),
        resolve
      };
      route.waiters.add(waiter);
    });
  }

  status({ message_id: messageId }) {
    assertString(messageId, "message_id", { maxBytes: 128 });
    const record = this.messages.get(messageId);
    if (!record) throw new PartylineError("not_found", `Message ${messageId} was not found`);
    if (record.state === "queued" && isExpired(record.message)) {
      record.state = "expired";
      record.updatedAt = new Date().toISOString();
    }
    return { ...publicMessage(record.message, record.state), updated_at: record.updatedAt };
  }

  consume(message) {
    const record = this.messages.get(message.message_id);
    if (record) {
      record.state = isExpired(message) ? "expired" : "delivered";
      record.updatedAt = new Date().toISOString();
    }
    return { ...message, delivery_state: record?.state ?? "delivered" };
  }

  prune(route) {
    const active = [];
    for (const message of route.queue) {
      if (isExpired(message)) {
        const record = this.messages.get(message.message_id);
        if (record) {
          record.state = "expired";
          record.updatedAt = new Date().toISOString();
        }
      } else {
        active.push(message);
      }
    }
    route.queue = active;
  }

  requireRoute(alias) {
    const route = this.routes.get(alias);
    if (!route) throw new PartylineError("route_not_found", `Route ${alias} is not registered`);
    return route;
  }

  requireCaller(caller, owner) {
    if (caller !== "operator" && caller !== owner) {
      throw new PartylineError("forbidden", `Only ${owner} can act as ${owner}`);
    }
  }

  trimHistory() {
    while (this.messages.size > this.maxHistory) {
      this.messages.delete(this.messages.keys().next().value);
    }
  }

  async handle(method, params = {}, caller = "operator", client = null) {
    switch (method) {
      case "ping":
        return { ok: true, version: 1 };
      case "register":
        return this.register(params, params.persistent && caller === "operator" ? null : client);
      case "unregister": {
        const alias = params.alias ?? caller;
        assertAlias(alias);
        this.requireCaller(caller, alias);
        this.unregisterRoute(alias);
        return { alias, unregistered: true };
      }
      case "list":
        return this.list();
      case "pair":
        return this.pair(params, caller);
      case "unpair":
        return this.unpair(params, caller);
      case "send":
        return this.send(params, caller);
      case "await":
        return this.awaitMessage(params, caller);
      case "status":
        return this.status(params);
      default:
        throw new PartylineError("method_not_found", `Unknown method: ${method}`);
    }
  }
}

async function prepareSocket(socketPath) {
  await fs.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  try {
    const stat = await fs.stat(socketPath);
    if (!stat.isSocket()) throw new PartylineError("socket_path_in_use", `${socketPath} is not a Unix socket`);
    const alive = await new Promise((resolve) => {
      const probe = net.createConnection(socketPath);
      const finish = (value) => {
        probe.destroy();
        resolve(value);
      };
      probe.once("connect", () => finish(true));
      probe.once("error", () => finish(false));
    });
    if (alive) throw new PartylineError("server_exists", `Partyline is already listening on ${socketPath}`);
    await fs.unlink(socketPath);
  } catch (error) {
    if (error instanceof PartylineError) throw error;
    if (error.code !== "ENOENT") throw error;
  }
}

export async function startBrokerServer({ socketPath = defaultSocketPath(), broker = new PartylineBroker() } = {}) {
  await prepareSocket(socketPath);
  let closeServer;
  const clients = new Set();
  const server = net.createServer((socket) => {
    const client = { socket, alias: null, operator: false, closed: false };
    clients.add(client);
    socket.setEncoding("utf8");
    socket.setNoDelay(true);
    const write = (value) => {
      if (!client.closed && socket.writable) socket.write(frame(value));
    };
    const handle = async (request) => {
      const id = request?.id;
      try {
        if (!request || typeof request.method !== "string") throw new PartylineError("invalid_request", "method is required");
        if (request.method === "hello") {
          if (request.params?.role === "operator") client.operator = true;
          write({ id, ok: true, result: { role: client.operator ? "operator" : "route" } });
          return;
        }
        if (request.method === "shutdown") {
          if (!client.operator) throw new PartylineError("forbidden", "shutdown requires an operator connection");
          socket.write(frame({ id, ok: true, result: { stopping: true } }), () => void closeServer?.());
          return;
        }
        const caller = client.operator ? "operator" : client.alias;
        const result = await broker.handle(request.method, request.params ?? {}, caller, client);
        write({ id, ok: true, result });
      } catch (error) {
        write({ id, ok: false, error: errorObject(error) });
      }
    };
    const parse = lineParser((request) => {
      void handle(request);
    });
    socket.on("data", (chunk) => {
      try {
        parse(chunk);
      } catch (error) {
        write({ id: null, ok: false, error: errorObject(error) });
        socket.destroy();
      }
    });
    socket.on("close", () => {
      client.closed = true;
      clients.delete(client);
      broker.unregisterClient(client);
    });
    socket.on("error", () => {
      client.closed = true;
      clients.delete(client);
      broker.unregisterClient(client);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  await fs.chmod(socketPath, 0o600);

  let closed = false;
  closeServer = async () => {
    if (closed) return;
    closed = true;
    for (const client of clients) client.socket.destroy();
    await new Promise((resolve) => server.close(() => resolve()));
    await fs.unlink(socketPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  };
  return { server, broker, socketPath, close: closeServer };
}

export class ControlClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    const parse = lineParser((response) => {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new PartylineError(response.error?.code ?? "remote_error", response.error?.message ?? "Remote request failed", response.error?.details));
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      try {
        parse(chunk);
      } catch (error) {
        this.fail(error);
      }
    });
    socket.on("close", () => this.fail(new PartylineError("disconnected", "Partyline broker disconnected")));
    socket.on("error", (error) => this.fail(error));
  }

  request(method, params = {}) {
    if (this.closed) return Promise.reject(new PartylineError("disconnected", "Partyline broker is disconnected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.socket.write(frame({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  close() {
    this.fail(new PartylineError("disconnected", "Partyline client closed"));
    this.socket.end();
  }
}

export async function connectControl(socketPath = defaultSocketPath()) {
  const socket = await new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    client.once("connect", () => resolve(client));
    client.once("error", reject);
  });
  return new ControlClient(socket);
}
