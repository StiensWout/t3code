import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

import type {
  AcpRegistryAvailableCommands,
  AcpRegistryLiveConfiguration,
} from "./AcpRegistryProbe.ts";
import { AcpRegistryRuntimeCoordinator } from "./AcpRegistryRuntimeCoordinator.ts";

describe("AcpRegistryRuntimeCoordinator", () => {
  it.effect("suppresses a background probe while foreground startup is active", () =>
    Effect.gen(function* () {
      const coordinator = yield* AcpRegistryRuntimeCoordinator;
      const foregroundStarted = yield* Deferred.make<void>();
      const releaseForeground = yield* Deferred.make<void>();
      const foreground = yield* coordinator
        .withForegroundStartup(
          "kilo",
          Deferred.succeed(foregroundStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseForeground)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(foregroundStarted);

      const probed = yield* coordinator.runBackgroundProbe("kilo", Effect.succeed("unexpected"));
      expect(Option.isNone(probed)).toBe(true);

      yield* Deferred.succeed(releaseForeground, undefined);
      yield* Fiber.join(foreground);
    }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer), Effect.scoped),
  );

  it.effect("interrupts an active background probe when foreground startup begins", () =>
    Effect.gen(function* () {
      const coordinator = yield* AcpRegistryRuntimeCoordinator;
      const probeStarted = yield* Deferred.make<void>();
      const probeFinalized = yield* Deferred.make<void>();
      const releaseForeground = yield* Deferred.make<void>();
      const probe = yield* coordinator
        .runBackgroundProbe(
          "kilo",
          Deferred.succeed(probeStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(probeFinalized, undefined).pipe(Effect.ignore)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(probeStarted);

      const foreground = yield* coordinator
        .withForegroundStartup("kilo", Deferred.await(releaseForeground))
        .pipe(Effect.forkChild);
      expect(Option.isNone(yield* Fiber.join(probe))).toBe(true);
      yield* Deferred.await(probeFinalized);

      yield* Deferred.succeed(releaseForeground, undefined);
      yield* Fiber.join(foreground);
    }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer), Effect.scoped),
  );

  it.effect("replays and replaces late command advertisements per provider instance", () =>
    Effect.gen(function* () {
      const coordinator = yield* AcpRegistryRuntimeCoordinator;
      const codex = ProviderInstanceId.make("acpRegistry_codex");
      const kilo = ProviderInstanceId.make("acpRegistry_kilo");
      const firstSeen = yield* Deferred.make<void>();
      const replacementSeen = yield* Deferred.make<void>();
      const received: Array<AcpRegistryAvailableCommands> = [];

      yield* coordinator.publishAvailableCommands(codex, {
        slashCommands: [{ name: "status" }],
        skills: [{ name: "workspace-skill", path: "acp://skill/workspace-skill", enabled: true }],
      });
      const consumer = yield* coordinator
        .watchAvailableCommands(codex, (commands) =>
          Effect.gen(function* () {
            received.push(commands);
            yield* received.length === 1
              ? Deferred.succeed(firstSeen, undefined)
              : Deferred.succeed(replacementSeen, undefined);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstSeen);

      yield* coordinator.publishAvailableCommands(kilo, {
        slashCommands: [{ name: "review" }],
        skills: [],
      });
      yield* coordinator.publishAvailableCommands(codex, { slashCommands: [], skills: [] });
      yield* Deferred.await(replacementSeen);
      yield* Fiber.interrupt(consumer);

      expect(received).toEqual([
        {
          slashCommands: [{ name: "status" }],
          skills: [{ name: "workspace-skill", path: "acp://skill/workspace-skill", enabled: true }],
        },
        { slashCommands: [], skills: [] },
      ]);
      expect(yield* coordinator.getAvailableCommands(kilo)).toEqual(
        Option.some({ slashCommands: [{ name: "review" }], skills: [] }),
      );
      yield* coordinator.clearAvailableCommands(codex);
      expect(Option.isNone(yield* coordinator.getAvailableCommands(codex))).toBe(true);
    }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer), Effect.scoped),
  );

  it.effect("replays and replaces live configuration per provider instance", () =>
    Effect.gen(function* () {
      const coordinator = yield* AcpRegistryRuntimeCoordinator;
      const instanceId = ProviderInstanceId.make("acpRegistry_kilo");
      const firstSeen = yield* Deferred.make<void>();
      const replacementSeen = yield* Deferred.make<void>();
      const received: Array<AcpRegistryLiveConfiguration> = [];
      const first = {
        models: [{ id: "sonnet", name: "Sonnet", description: null }],
        currentModelId: "sonnet",
        configOptions: [],
      } satisfies AcpRegistryLiveConfiguration;
      const replacement = {
        models: [{ id: "opus", name: "Opus", description: null }],
        currentModelId: "opus",
        configOptions: [],
      } satisfies AcpRegistryLiveConfiguration;

      yield* coordinator.publishLiveConfiguration(instanceId, first);
      const consumer = yield* coordinator
        .watchLiveConfiguration(instanceId, (configuration) =>
          Effect.gen(function* () {
            received.push(configuration);
            yield* received.length === 1
              ? Deferred.succeed(firstSeen, undefined)
              : Deferred.succeed(replacementSeen, undefined);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstSeen);
      yield* coordinator.publishLiveConfiguration(instanceId, replacement);
      yield* Deferred.await(replacementSeen);
      yield* Fiber.interrupt(consumer);

      expect(received).toEqual([first, replacement]);
      expect(yield* coordinator.getLiveConfiguration(instanceId)).toEqual(Option.some(replacement));
      yield* coordinator.clearLiveConfiguration(instanceId);
      expect(Option.isNone(yield* coordinator.getLiveConfiguration(instanceId))).toBe(true);
    }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer), Effect.scoped),
  );

  it.effect("requires matching user consent before accepting URL authentication", () =>
    Effect.gen(function* () {
      const coordinator = yield* AcpRegistryRuntimeCoordinator;
      const instanceId = ProviderInstanceId.make("acpRegistry_antigravity");
      const action = {
        elicitationId: "login-1",
        url: "https://accounts.example.com/login",
        message: "Continue in your browser",
      };
      const actionSeen = yield* Deferred.make<void>();
      const consumer = yield* coordinator
        .watchUrlAuthAction(instanceId, (current) =>
          current === null
            ? Effect.void
            : Deferred.succeed(actionSeen, undefined).pipe(Effect.asVoid),
        )
        .pipe(Effect.forkChild);
      const request = yield* coordinator
        .requestUrlAuthentication(instanceId, action)
        .pipe(Effect.forkChild);
      yield* Deferred.await(actionSeen);

      expect(
        yield* coordinator.acceptUrlAuthentication({ instanceId, elicitationId: "stale" }),
      ).toBe(false);
      expect(
        yield* coordinator.acceptUrlAuthentication({ instanceId, elicitationId: "login-1" }),
      ).toBe(true);
      expect(yield* Fiber.join(request)).toBe(true);
      expect(Option.isNone(yield* coordinator.getUrlAuthAction(instanceId))).toBe(true);
      yield* Fiber.interrupt(consumer);
    }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer), Effect.scoped),
  );
});
