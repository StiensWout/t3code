/**
 * Provider account limits: the rolling quota windows a subscription provider
 * reports for the signed-in account, plus Codex banked reset credits.
 *
 * Limits are account state, not thread history. Adapters normalise their
 * native payloads at the boundary; the server keeps only the latest snapshot
 * per provider instance.
 *
 * @module usageLimits
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { UsageProviderKind } from "./usage.ts";

export const UsageLimitWindow = Schema.Struct({
  /** Stable per provider, e.g. `primary`, `five_hour`. Sparse updates merge on it. */
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  /** 0..100 */
  usedPercent: Schema.Number,
  resetsAt: Schema.NullOr(IsoDateTime),
  windowMinutes: Schema.NullOr(NonNegativeInt),
});
export type UsageLimitWindow = typeof UsageLimitWindow.Type;

/** Codex reset credits banked on the account. */
export const UsageLimitResetCredits = Schema.Struct({
  availableCount: NonNegativeInt,
  nextExpiresAt: Schema.NullOr(IsoDateTime),
});
export type UsageLimitResetCredits = typeof UsageLimitResetCredits.Type;

/**
 * Sparse update from one provider event or read. Windows replace by id, the
 * other fields only when present.
 */
export const UsageLimitsUpdate = Schema.Struct({
  plan: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  windows: Schema.Array(UsageLimitWindow),
  resetCredits: Schema.optional(Schema.NullOr(UsageLimitResetCredits)),
});
export type UsageLimitsUpdate = typeof UsageLimitsUpdate.Type;

export const UsageProviderLimits = Schema.Struct({
  provider: UsageProviderKind,
  instanceId: ProviderInstanceId,
  /** The instance's configured display name, for telling two Codex homes apart. */
  instanceLabel: Schema.NullOr(TrimmedNonEmptyString),
  plan: Schema.NullOr(TrimmedNonEmptyString),
  windows: Schema.Array(UsageLimitWindow),
  resetCredits: Schema.NullOr(UsageLimitResetCredits),
  /** When the provider last reported any of these numbers. */
  observedAt: IsoDateTime,
});
export type UsageProviderLimits = typeof UsageProviderLimits.Type;

export const UsageLimitsSnapshot = Schema.Struct({
  providers: Schema.Array(UsageProviderLimits),
});
export type UsageLimitsSnapshot = typeof UsageLimitsSnapshot.Type;

export const UsageLimitsConsumeResetInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type UsageLimitsConsumeResetInput = typeof UsageLimitsConsumeResetInput.Type;

export const UsageLimitsConsumeResetOutcome = Schema.Literals([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);
export type UsageLimitsConsumeResetOutcome = typeof UsageLimitsConsumeResetOutcome.Type;

export const UsageLimitsConsumeResetResult = Schema.Struct({
  outcome: UsageLimitsConsumeResetOutcome,
});
export type UsageLimitsConsumeResetResult = typeof UsageLimitsConsumeResetResult.Type;

export class UsageLimitsError extends Schema.TaggedErrorClass<UsageLimitsError>()(
  "UsageLimitsError",
  {
    reason: Schema.Literals(["unsupported", "requestFailed"]),
    /** Stable, bounded description. The underlying failure travels in `cause`. */
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Usage limits request failed (${this.reason}): ${this.detail}`;
  }
}
