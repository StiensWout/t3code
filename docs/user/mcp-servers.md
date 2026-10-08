# MCP servers

Add an MCP server in **Settings > Providers > MCPs** for the connected environment. Define a stdio command or an HTTP endpoint once, then enable it for the provider accounts that should use it. Copying assignments adds the source account's enabled servers to the target and preserves its existing assignments.

These settings apply to agents started through T3 Code. They do not change standalone CLIs or IDEs. Each environment has its own catalog and credentials. Changes take effect when an affected provider session next starts; running sessions show that a restart is pending. Changing an OAuth endpoint, authentication headers, or client credentials clears its sign-in immediately, including access from running sessions.

For stdio servers, supply arguments, an optional working directory, and environment variables. For HTTP servers, supply the endpoint and any required headers. Environment variables and headers can reference `${VAR}` or `{env:VAR}` on the server; commands, arguments, and URLs are literal. Mark credential values as sensitive to hide environment variables, headers, and OAuth client secrets when settings are read. URLs and command arguments remain visible to clients with settings read access; put credentials in sensitive environment variables or headers. Agents without full access receive only a catalog summary. OAuth servers support browser sign-in, cancellation, retry, and sign-out. T3 Code refreshes OAuth credentials while sessions run.

If a server needs an environment variable that is missing, T3 skips it for that session and shows which variable to set. Other MCP servers and the agent can still start.

To import existing definitions, paste the provider's JSON, JSONC, or TOML configuration and review the preview before saving. Imported entries are independent copies. Native provider configuration and native sign-ins remain active, so remove native duplicates yourself if necessary. Native export is not available yet.

Managed MCPs require a T3-owned OpenCode server. They cannot be added to externally managed OpenCode servers.
