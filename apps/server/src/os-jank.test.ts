import { assert, it } from "@effect/vitest";

import { hydratePosixHome } from "./os-jank.ts";

it("hydrates HOME for minimal service environments", () => {
  const env: NodeJS.ProcessEnv = {};

  hydratePosixHome(env, "/home/service-user");

  assert.equal(env.HOME, "/home/service-user");
});

it("hydrates a blank HOME value", () => {
  const env: NodeJS.ProcessEnv = { HOME: " " };

  hydratePosixHome(env, "/home/service-user");

  assert.equal(env.HOME, "/home/service-user");
});

it("preserves an explicitly configured HOME", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/custom/home" };

  hydratePosixHome(env, "/home/service-user");

  assert.equal(env.HOME, "/custom/home");
});
