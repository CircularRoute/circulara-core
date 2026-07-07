/**
 * WS1 - plugin config surface: tenant + seat identity + backend URL.
 * Read from environment (the MCP host's env block or the hook's env):
 *   CIRCULARA_BACKEND_URL   e.g. http://127.0.0.1:8787
 *   CIRCULARA_TENANT_ID     tenant UUID
 *   CIRCULARA_TOKEN         bearer token (OIDC access token for humans,
 *                           short-lived agent token for named agents)
 *   CIRCULARA_SEAT_ID       this identity's seat UUID
 *   CIRCULARA_USER_ID       SSO subject (human) or owning human (agent)
 *   CIRCULARA_IDENTITY_TYPE human | named_agent  (default human)
 *   CIRCULARA_TEAM_ID       optional
 *   CIRCULARA_AGENT_IDENTITY optional (named agents)
 * No provider keys here, ever - the plugin never touches them (D4: utility
 * calls run tenant-side; the plugin only reports and asks).
 */
export interface PluginConfig {
  backendUrl: string;
  tenantId: string;
  token: string;
  seatId: string;
  userId: string;
  identityType: "human" | "named_agent";
  teamId: string | null;
  agentIdentity: string | null;
  host: "claude_code" | "cursor" | "other";
}

export function loadPluginConfig(env = process.env): PluginConfig {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`missing ${k} in plugin environment`);
    return v;
  };
  return {
    backendUrl: (env.CIRCULARA_BACKEND_URL ?? "http://127.0.0.1:8787").replace(/\/$/, ""),
    tenantId: need("CIRCULARA_TENANT_ID"),
    token: need("CIRCULARA_TOKEN"),
    seatId: need("CIRCULARA_SEAT_ID"),
    userId: need("CIRCULARA_USER_ID"),
    identityType:
      env.CIRCULARA_IDENTITY_TYPE === "named_agent" ? "named_agent" : "human",
    teamId: env.CIRCULARA_TEAM_ID ?? null,
    agentIdentity: env.CIRCULARA_AGENT_IDENTITY ?? null,
    host:
      env.CIRCULARA_HOST === "cursor"
        ? "cursor"
        : env.CIRCULARA_HOST === "other"
          ? "other"
          : "claude_code",
  };
}
