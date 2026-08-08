import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  DesktopDiscordPresence,
  formatDiscordPresence,
  make,
  type DiscordRpcClient,
} from "./DesktopDiscordPresence.ts";

function makeFakeClient() {
  const activities: string[] = [];
  let clearCount = 0;
  let destroyCount = 0;
  let connected = false;
  const client: DiscordRpcClient = {
    get isConnected() {
      return connected;
    },
    user: {
      setActivity: ({ details }) => {
        activities.push(details);
        return Promise.resolve();
      },
      clearActivity: () => {
        clearCount += 1;
        return Promise.resolve();
      },
    },
    login: () => {
      connected = true;
      return Promise.resolve();
    },
    destroy: () => {
      connected = false;
      destroyCount += 1;
      return Promise.resolve();
    },
    on: () => client,
  };
  return {
    client,
    activities,
    get clearCount() {
      return clearCount;
    },
    get destroyCount() {
      return destroyCount;
    },
  };
}

describe("DesktopDiscordPresence", () => {
  it("formats singular and plural presence without project details", () => {
    expect(formatDiscordPresence(1)).toBe("Working in T3 Code on 1 project");
    expect(formatDiscordPresence(3)).toBe("Working in T3 Code on 3 projects");
  });

  it.effect("connects lazily, updates the count, and clears at zero", () => {
    const fake = makeFakeClient();
    const layer = Layer.effect(
      DesktopDiscordPresence,
      make({ applicationId: "public-app-id", createClient: () => fake.client }),
    );

    return Effect.gen(function* () {
      const presence = yield* DesktopDiscordPresence;
      expect(presence.available).toBe(true);
      expect(fake.activities).toEqual([]);

      yield* presence.setActiveProjectCount(2);
      yield* presence.setActiveProjectCount(4);
      expect(fake.activities).toEqual([
        "Working in T3 Code on 2 projects",
        "Working in T3 Code on 4 projects",
      ]);

      yield* presence.setActiveProjectCount(0);
      expect(fake.clearCount).toBe(1);
      expect(fake.destroyCount).toBe(1);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("stays unavailable and does not connect without an application ID", () => {
    let createCount = 0;
    const layer = Layer.effect(
      DesktopDiscordPresence,
      make({
        applicationId: "",
        createClient: () => {
          createCount += 1;
          return makeFakeClient().client;
        },
      }),
    );

    return Effect.gen(function* () {
      const presence = yield* DesktopDiscordPresence;
      expect(presence.available).toBe(false);
      yield* presence.setActiveProjectCount(1);
      expect(createCount).toBe(0);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });
});
