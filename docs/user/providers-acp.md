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
configuration option, just like model discovery for built-in providers. When an agent advertises a
model configuration option, its base models are the model list; legacy model-times-reasoning
combinations from the session models API are collapsed instead of duplicating the picker.
Discovered models are not written into settings. An authenticated agent may still advertise no
models, in which case T3 Code keeps the existing custom model controls.

A successful discovery scan is reused for a while instead of re-running on every periodic health
refresh, so configured agents are not repeatedly spawned in the background. Failed or
unauthenticated scans always retry on the next refresh.

Other session configuration the agent advertises (reasoning effort, approval mode, custom selects,
and boolean toggles) appears in the composer's model options menu, exactly like built-in provider
options. Two categories are integrated instead of listed: model selection stays on the model picker,
and an agent-advertised plan/build collaboration mode follows T3 Code's own Plan and Build toggle.
Agents that expose session modes without configuration options get a single **Mode** option with
the same behavior.

ACP does not define a system or developer prompt channel. T3 Code supplies concise interaction-mode
guidance with the first prompt and whenever Plan or Build mode changes. When the T3 Code MCP tools
are attached, that guidance also explains delegated tasks, scheduled work, and the collaborative
browser.

T3 Code supplies its orchestration tools through ACP's stdio MCP transport. If an agent accepts but
does not expose the injected server, T3 Code provides the same thread-scoped tools through a terminal
fallback. Agents can therefore delegate child tasks and use the other T3 Code tools without optional
HTTP MCP support. Permission requests for these tools follow the thread's normal runtime and sandbox
settings. Full-access threads approve permitted calls automatically; approval-required threads
continue to ask.

Checkpoint rollback works on ACP threads with reset semantics: ACP defines no conversation
truncation, so T3 Code restores the checkpointed workspace state and the next turn starts a fresh
agent session. The agent does not retain conversation context from before the checkpoint.

## Agent Capabilities

T3 Code advertises the ACP client `fs` and `terminal` capabilities to registry agents. Agents that
prefer client-mediated file access read and write text files through T3 Code, and agents that run
commands through client terminals execute them on the connected server with the provider
instance's environment. Embedded terminal output appears inside the agent's tool call in the
thread. Terminals are killed when the session closes.

Commands advertised through ACP's `available_commands_update` stay current while a normal agent
session is running. Type `/` to see regular commands under **Provider**. Advertised command names
that begin with `$` appear in T3 Code's `$` skill menu instead, with the prefix removed from the
display name and restored when selected. This works for any ACP agent that follows that convention.
ACP does not define a separate portable installed-skills inventory, so T3 Code can only list skills
the agent advertises as user-invocable `$` commands.

When an agent advertises a terminal-based authentication method, the provider card shows the exact
command to run in a thread terminal on that environment. For environment-variable methods, the
card names the variables to set under the instance's environment settings.

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
