# ACP Registry

T3 Code can add coding agents from the official
[ACP Registry](https://agentclientprotocol.com/get-started/registry). These agents use the Agent
Client Protocol, so they keep their own models, tools, configuration, and authentication while T3
Code provides the project and thread interface.

## Add An ACP Agent

1. Open **Settings → Providers**.
2. Select **Add provider instance**.
3. Choose **ACP Registry**.
4. Search for the agent you want, then select **Add** on its result.
5. Confirm the prefilled display name and instance ID.
6. Select **Add instance**.

Search results come from the official registry and only show distributions that can run on the
connected server's operating system and architecture. The source repository or website is shown
when the registry provides one.

Official registry icons are fetched from the ACP CDN once and kept in the browser cache. T3 Code
uses a local ACP fallback when an icon is absent, invalid, too large, or cannot be loaded.

The Add action lets T3 Code prepare third-party code on the connected server. Review the agent's
source and license before adding it.

## Where The Agent Is Installed

ACP agents run on the machine hosting the connected T3 Code server. This remains true when you use
`app.t3.codes`, T3 Connect, a relay, or another remote connection.

T3 Code handles registry distributions as follows:

- Binary distributions are downloaded into T3 Code's managed, versioned cache before the provider
  instance is added. T3 Code checks the registry's SHA-256 value when one is available.
- `npx` and `uvx` distributions keep their exact version-pinned registry command. Their package
  runner downloads the package when the first normal agent session starts.

Removing the last provider instance for an agent also removes that agent's T3-managed binary files.
T3 Code never purges shared `npx` or `uvx` package-runner caches.

## Authentication

T3 Code does not collect or copy credentials for registry agents. Authentication is performed by
the agent on the connected server machine.

ACP agents can advertise agent-managed, terminal, or environment-variable authentication methods.
T3 Code reports the advertised method without encoding provider-specific login behavior in the ACP
adapter. Complete the method on the connected server, using the same user account that runs T3
Code. Environment variables can be set on the provider instance.

The normal provider health scan starts a disposable `session/new` and closes the process. It never
starts an interactive sign-in flow, so one unauthenticated agent cannot hold up checks for the other
providers. Success means the agent can create a session; ACP does not provide a universal passive
login-status endpoint. After completing authentication, T3 Code detects it during the next
automatic scan. Starting a real conversation takes priority over this disposable work: T3 Code
cancels or skips a same-agent scan while the conversation's ACP process is starting.

The provider snapshot exposes model choices advertised through ACP's session model state or model
configuration option, just like model discovery for built-in providers. Discovered models are not
written into settings. An authenticated agent may still advertise no models, in which case T3 Code
keeps the existing custom model controls.

Commands advertised through ACP's `available_commands_update` stay current while a normal agent
session is running. Type `/` to see regular commands under **Provider**. Advertised command names
that begin with `$` appear in T3 Code's `$` skill menu instead, with the prefix removed from the
display name and restored when selected. This works for any ACP agent that follows that convention.
ACP does not define a separate portable installed-skills inventory, so T3 Code can only list skills
the agent advertises as user-invocable `$` commands.

For Codex ACP, credentials belong to the Codex CLI on the server. Run `codex login status` there to
check them, or `codex login --device-auth` to sign in with a ChatGPT subscription.

Grok Build currently advertises an agent-managed “Sign in with Grok” ACP method, but does not expose
its remote-friendly device-code command through ACP. On a remote or headless server, run
`grok login --device-auth`. If Grok is only available through the registry's package runner, use
`npx -y @xai-official/grok login --device-auth`. See the
[Grok Build authentication guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md).

## Advanced Configuration

The provider instance settings retain a few manual controls:

- **Executable override** uses an existing local executable instead of the managed distribution,
  while preserving the registry-declared arguments and environment.
- **Authentication method** selects a specific ACP authentication method ID when the agent advertises
  more than one.
- **Custom models** can supply model IDs that the agent does not advertise.

Changing the local executable or completing manual setup is picked up by the normal automatic
provider scan. The provider-section refresh also updates installation, authentication, and model
metadata together.
