# @circulara/plugin

Circulara Observe MCP plugin - meters your AI agents' token spend and carbon (free tier).

Install (after signing in at https://plugin.circulara.ai and copying your env block from the
Connect page):

```
claude mcp add circulara -- npx -y -p @circulara/plugin circulara-mcp
```

## Publishing a new version

1. Bump `version` in `package.json` (keep `mcpName` = `ai.circulara/plugin`).
2. Build + publish to npm: `npm run build -w @circulara/plugin` then, from `packages/plugin`,
   `npm publish` (public scope, OTP).
3. Update `server.json` so its `version` and each package `version` match the new npm version
   (its `name` must stay `ai.circulara/plugin` = the package's `mcpName`).
4. Publish the MCP-registry entry: `mcp-publisher publish` using DNS auth for the `circulara.ai`
   domain. The DNS signing key is `mcp-dns-key.pem` - a CREDENTIAL, kept OUT of git (see
   `.gitignore`), held by the CTO. Never commit it.

The registry entry auto-propagates to most other MCP directories.
