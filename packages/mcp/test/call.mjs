// Calls tools on the bundled MCP server over real stdio. Usage: node call.mjs '<tool>' '<json args>' ['<tool>' '<json>' ...]
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const client = new Client({ name: "qa", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../../../hermes-plugin/mcp/server.mjs", import.meta.url))], env: { ...process.env, SOUS_CHEF_BUNDLED: "1" } }));
const a = process.argv.slice(2);
for (let i = 0; i < a.length; i += 2) {
  const r = await client.callTool({ name: a[i], arguments: JSON.parse(a[i + 1]) });
  const t = r.content.find((c) => c.type === "text")?.text ?? "";
  console.log(`${a[i]}${r.isError ? " ERROR" : ""}: ${t.length > 900 ? t.slice(0, 900) + "…" : t}`);
}
await client.close();
