import { connectControl } from "./broker.mjs";
import { errorObject } from "./protocol.mjs";

export async function runRpc({ socketPath, name, kind = "unknown", session = null }) {
  const client = await connectControl(socketPath);
  try {
    if (name) await client.request("register", { alias: name, kind, session });
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
          const value = await client.request(request.method, request.params ?? {});
          process.stdout.write(`${JSON.stringify({ id: request.id ?? null, ok: true, result: value })}\n`);
        } catch (error) {
          process.stdout.write(`${JSON.stringify({ id: request?.id ?? null, ok: false, error: errorObject(error) })}\n`);
        }
      }
    }
  } finally {
    client.close();
  }
}
