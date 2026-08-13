import * as Schema from "effect/Schema";

import * as AcpSchema from "./_generated/schema.gen.ts";

/** ACP protocol v1 wire names that superseded the pre-1.0 elicitation names. */
export const CURRENT_CLIENT_METHODS = {
  elicitation_create: "elicitation/create",
  elicitation_complete: "elicitation/complete",
} as const;

/** All ACP elicitation generations normalize to the current flat action shape. */
export type NormalizedElicitationResponse =
  | {
      readonly action: "accept";
      readonly content?: Readonly<Record<string, AcpSchema.ElicitationContentValue>> | null;
      readonly _meta?: Readonly<Record<string, unknown>> | null;
    }
  | {
      readonly action: "decline" | "cancel";
      readonly _meta?: Readonly<Record<string, unknown>> | null;
    };
export const NormalizedElicitationResponse = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("accept"),
    content: Schema.optionalKey(
      Schema.Union([Schema.Record(Schema.String, AcpSchema.ElicitationContentValue), Schema.Null]),
    ),
    _meta: Schema.optionalKey(
      Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Null]),
    ),
  }),
  Schema.Struct({
    action: Schema.Literal("decline"),
    _meta: Schema.optionalKey(
      Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Null]),
    ),
  }),
  Schema.Struct({
    action: Schema.Literal("cancel"),
    _meta: Schema.optionalKey(
      Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Null]),
    ),
  }),
]);

/** Convert T3's normalized reply for pre-1.0 agents that expect a nested action. */
export function toLegacyElicitationResponse(
  response: NormalizedElicitationResponse,
): AcpSchema.ElicitationResponse {
  const meta = response._meta === undefined ? {} : { _meta: response._meta };
  switch (response.action) {
    case "accept":
      return {
        ...meta,
        action: {
          action: "accept",
          ...(response.content === undefined ? {} : { content: response.content }),
        },
      };
    case "decline":
      return { ...meta, action: { action: "decline" } };
    case "cancel":
      return { ...meta, action: { action: "cancel" } };
  }
}
