import type { SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { ForkUpstream } from "../sourceControl/forkUpstream.ts";

interface CheckoutRepository {
  readonly cwd: string;
  readonly kind: SourceControlProviderKind;
  readonly host: string;
  readonly repository: string;
}

// Git resolves pull request head refs by number against the checkout's own remote.
export const pullRequestCheckoutAllowed = Effect.fn("GitManager.pullRequestCheckoutAllowed")(
  function* (
    getParent: ForkUpstream["Service"]["getParent"],
    checkout: CheckoutRepository | undefined,
    target: Pick<CheckoutRepository, "host" | "repository">,
  ) {
    if (
      checkout?.kind !== "github" ||
      checkout.host.toLowerCase() !== target.host.toLowerCase() ||
      checkout.repository.toLowerCase() === target.repository.toLowerCase()
    ) {
      return true;
    }
    return yield* getParent(checkout).pipe(
      Effect.map((parent) => parent?.toLowerCase() !== target.repository.toLowerCase()),
      // A failed lookup cannot establish that the target is safe to fetch from this checkout.
      Effect.orElseSucceed(() => false),
    );
  },
);
