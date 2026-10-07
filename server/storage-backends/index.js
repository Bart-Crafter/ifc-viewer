import path from "node:path";
import { createLocalBackend } from "./local.js";
import { createGraphBackend } from "./graph.js";

// SharePoint when the Microsoft app credentials are configured; otherwise a local folder (development/testing only).
export function createBackend({ dataDir, env }) {
  if (env.AZURE_TENANT_ID && env.AZURE_CLIENT_ID && env.AZURE_CLIENT_SECRET) {
    return createGraphBackend({
      tenantId: env.AZURE_TENANT_ID,
      clientId: env.AZURE_CLIENT_ID,
      clientSecret: env.AZURE_CLIENT_SECRET,
      graphBase: env.GRAPH_BASE_URL,
      loginBase: env.LOGIN_BASE_URL,
    });
  }
  return createLocalBackend({ rootDir: path.join(dataDir, "projects") });
}
