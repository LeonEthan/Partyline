import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { connectControl, startBrokerServer } from "../src/broker.mjs";

test("paired routes deliver one bounded message and expose terminal metadata", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "partyline-test-"));
  const socketPath = path.join(directory, "partyline.sock");
  const running = await startBrokerServer({ socketPath });
  const sender = await connectControl(socketPath);
  const receiver = await connectControl(socketPath);
  try {
    await sender.request("register", { alias: "codex", kind: "codex" });
    await receiver.request("register", { alias: "pi", kind: "pi" });
    await sender.request("pair", { from: "codex", to: "pi" });
    await assert.rejects(
      sender.request("send", { from: "codex", to: "missing", text: "nope" }),
      (error) => error.code === "route_not_found"
    );

    const sent = await sender.request("send", { from: "codex", to: "pi", text: "review this diff", expects_reply: true });
    const received = await receiver.request("await", { alias: "pi", timeout_ms: 1000 });
    assert.equal(received.body.text, "review this diff");
    assert.equal(received.message_id, sent.message_id);
    assert.equal((await sender.request("status", { message_id: sent.message_id })).delivery_state, "delivered");
  } finally {
    sender.close();
    receiver.close();
    await running.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
