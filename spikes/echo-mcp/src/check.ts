// V11 check: talk to the running server with the official client, twice, to prove statelessness.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.JW_URL ?? "http://127.0.0.1:8080/mcp");

for (let i = 1; i <= 2; i++) {
  const client = new Client({ name: "check", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  const tools = await client.listTools();
  const res = await client.callTool({ name: "echo", arguments: { text: `hello ${i}` } });
  console.log(`run ${i}: tools=${tools.tools.map((t) => t.name)} readOnly=${tools.tools[0]?.annotations?.readOnlyHint} result=${JSON.stringify(res.content)}`);
  await client.close();
}

// Raw request with no session header must also work (stateless).
const raw = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
console.log("raw tools/list without session:", raw.status, raw.headers.get("mcp-session-id") ?? "(no session id)");
