/**
 * On-demand Claude Code account limits. The SDK only reports limits during a
 * turn, so this reads the same claude.ai usage endpoint the CLI's `/usage`
 * dialog uses, authenticated with the OAuth token Claude Code already stored
 * on disk. The token never leaves the server; only normalised percentages do.
 *
 * @module provider/Layers/claudeAccountLimits
 */
import type { ClaudeSettings, UsageLimitWindow, UsageLimitsUpdate } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { HttpClient } from "effect/unstable/http";
import { HttpClientResponse } from "effect/unstable/http";

import { resolveClaudeHomePath } from "../Drivers/ClaudeHome.ts";
import { type ProviderAdapterError, ProviderAdapterRequestError } from "../Errors.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const REQUEST_TIMEOUT = "10 seconds";
const METHOD = "claude.ai/usage";

const StoredCredentials = Schema.Struct({
  claudeAiOauth: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        accessToken: Schema.String,
        expiresAt: Schema.optional(Schema.NullOr(Schema.Number)),
        subscriptionType: Schema.optional(Schema.NullOr(Schema.String)),
        rateLimitTier: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});
const decodeStoredCredentials = Schema.decodeUnknownEffect(
  Schema.fromJsonString(StoredCredentials),
);

const UsageWindow = Schema.NullOr(
  Schema.Struct({
    utilization: Schema.NullOr(Schema.Number),
    resets_at: Schema.NullOr(Schema.String),
  }),
);
/** One entry of the endpoint's self-describing `limits` array. */
const UsageLimit = Schema.Struct({
  kind: Schema.String,
  percent: Schema.NullOr(Schema.Number),
  resets_at: Schema.NullOr(Schema.String),
  scope: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        model: Schema.optional(
          Schema.NullOr(Schema.Struct({ display_name: Schema.NullOr(Schema.String) })),
        ),
        surface: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});
const ExtraUsage = Schema.NullOr(
  Schema.Struct({
    is_enabled: Schema.Boolean,
    utilization: Schema.NullOr(Schema.Number),
  }),
);
const UsageResponse = Schema.Struct({
  limits: Schema.optional(Schema.NullOr(Schema.Array(UsageLimit))),
  extra_usage: Schema.optional(ExtraUsage),
  five_hour: Schema.optional(UsageWindow),
  seven_day: Schema.optional(UsageWindow),
  seven_day_opus: Schema.optional(UsageWindow),
  seven_day_sonnet: Schema.optional(UsageWindow),
});
const isUsageResponse = Schema.is(UsageResponse);
export type ClaudeUsageResponse = typeof UsageResponse.Type;

const SESSION_MINUTES = 300;
const WEEK_MINUTES = 10080;

/** Legacy top-level keys, used only when the `limits` array is absent. */
const LEGACY_WINDOWS = [
  { key: "five_hour", label: "5 hour", windowMinutes: SESSION_MINUTES },
  { key: "seven_day", label: "Weekly", windowMinutes: WEEK_MINUTES },
  { key: "seven_day_opus", label: "Weekly Opus", windowMinutes: WEEK_MINUTES },
  { key: "seven_day_sonnet", label: "Weekly Sonnet", windowMinutes: WEEK_MINUTES },
] as const;

/** Ids match the SDK's `rate_limit_event` types so turn-driven updates merge onto the same rows. */
function scopedId(name: string): string {
  return `seven_day_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

/** `default_claude_max_20x` → `Max 20x`, otherwise the subscription type capitalised. */
export function tierLabel(
  subscriptionType: string | null | undefined,
  rateLimitTier: string | null | undefined,
): string | null {
  const multiple = rateLimitTier?.match(/max_(\d+)x/);
  if (multiple) return `Max ${multiple[1]}x`;
  if (!subscriptionType) return null;
  return subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
}

/** Endpoint percentages are already 0..100. */
export function normalizeClaudeUsage(
  response: ClaudeUsageResponse,
  plan: string | null,
): UsageLimitsUpdate {
  const windows: UsageLimitWindow[] = [];
  const clamp = (value: number) => Math.max(0, Math.min(100, value));

  if (response.limits) {
    for (const limit of response.limits) {
      if (limit.percent === null) continue;
      const scopeName = limit.scope?.model?.display_name ?? limit.scope?.surface ?? null;
      const window =
        limit.kind === "session"
          ? { id: "five_hour", label: "5 hour", windowMinutes: SESSION_MINUTES }
          : limit.kind === "weekly_all"
            ? { id: "seven_day", label: "Weekly", windowMinutes: WEEK_MINUTES }
            : limit.kind === "weekly_scoped" && scopeName
              ? {
                  id: scopedId(scopeName),
                  label: `Weekly ${scopeName}`,
                  windowMinutes: WEEK_MINUTES,
                }
              : null;
      if (window === null) continue;
      windows.push({
        ...window,
        usedPercent: clamp(limit.percent),
        resetsAt: limit.resets_at,
      });
    }
    // Turn events report extra usage under `overage`; a complete read must
    // carry the same window or it would delete what an event created.
    const extra = response.extra_usage;
    if (extra && extra.is_enabled && extra.utilization !== null) {
      windows.push({
        id: "overage",
        label: "Extra usage",
        usedPercent: clamp(extra.utilization),
        resetsAt: null,
        windowMinutes: null,
      });
    }
    return { complete: true, windows, plan };
  }

  for (const legacy of LEGACY_WINDOWS) {
    const value = response[legacy.key];
    if (!value || value.utilization === null) continue;
    windows.push({
      id: legacy.key,
      label: legacy.label,
      usedPercent: clamp(value.utilization),
      resetsAt: value.resets_at,
      windowMinutes: legacy.windowMinutes,
    });
  }
  // The named keys are a partial view, so they merge rather than replace.
  return { complete: false, windows, plan };
}

const requestError = (detail: string, cause?: unknown) =>
  new ProviderAdapterRequestError({
    provider: "claudeAgent",
    method: METHOD,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

/**
 * Where Claude Code keeps this instance's credentials, with the precedence
 * the driver gives the CLI: a configured home becomes `CLAUDE_CONFIG_DIR`
 * and wins outright; otherwise the instance environment's own
 * `CLAUDE_CONFIG_DIR` or `HOME` applies, then the machine's home.
 */
export function claudeConfigDir(input: {
  readonly environment: NodeJS.ProcessEnv | undefined;
  readonly homePath: string;
  readonly resolvedHome: string;
  readonly join: (...parts: string[]) => string;
}): string {
  if (input.homePath.trim().length > 0) return input.resolvedHome;
  const configured = input.environment?.CLAUDE_CONFIG_DIR?.trim();
  if (configured) return configured;
  const home = input.environment?.HOME?.trim();
  return input.join(home || input.resolvedHome, ".claude");
}

export interface ClaudeAccountLimitsServices {
  readonly settings: Pick<ClaudeSettings, "homePath">;
  /** The instance's process environment, for `CLAUDE_CONFIG_DIR` and `HOME` overrides. */
  readonly environment: NodeJS.ProcessEnv | undefined;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly httpClient: HttpClient.HttpClient;
}

/**
 * Builds the reader once per adapter with its services captured, so the
 * adapter can expose it with no requirements. Yields null when this machine
 * has no usable claude.ai sign-in (API key sessions, expired token); the
 * runtime event path still updates limits during turns.
 */
export function makeClaudeAccountLimitsReader(
  services: ClaudeAccountLimitsServices,
): Effect.Effect<UsageLimitsUpdate | null, ProviderAdapterError> {
  const { settings, environment, fileSystem, path, httpClient } = services;

  const readCredentials = Effect.gen(function* () {
    const home = yield* resolveClaudeHomePath(settings).pipe(
      Effect.provideService(Path.Path, path),
    );
    const configDir = claudeConfigDir({
      environment,
      homePath: settings.homePath,
      resolvedHome: home,
      join: (...parts) => path.join(...parts),
    });
    // macOS keeps Claude Code's credentials in the login keychain, and reading
    // that item from another process triggers a Keychain prompt on every
    // refresh. Until that is an explicit opt-in, macOS relies on turn events.
    const raw = yield* fileSystem
      .readFileString(path.join(configDir, ".credentials.json"))
      .pipe(Effect.orElseSucceed(() => null));
    if (raw === null) return null;
    const parsed = yield* decodeStoredCredentials(raw).pipe(Effect.orElseSucceed(() => null));
    const oauth = parsed?.claudeAiOauth;
    if (!oauth) return null;
    const now = yield* Clock.currentTimeMillis;
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= now) return null;
    return oauth;
  });

  return Effect.gen(function* () {
    const credentials = yield* readCredentials;
    if (credentials === null) return null;
    const body = yield* httpClient
      .get(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          Accept: "application/json",
        },
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError((cause) => requestError("The claude.ai usage request failed.", cause)),
      );
    if (!isUsageResponse(body)) {
      return yield* requestError("The claude.ai usage response had an unexpected shape.");
    }
    return normalizeClaudeUsage(
      body,
      tierLabel(credentials.subscriptionType, credentials.rateLimitTier),
    );
  });
}
