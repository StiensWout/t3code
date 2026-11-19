import type { SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { ForkUpstream } from "../sourceControl/forkUpstream.ts";

interface CheckoutRepository {
  readonly cwd: string;
  readonly kind: SourceControlProviderKind;
  readonly host: string;
  readonly repository: string;
}

// When browsing a fork's parent, only its own contributions are actionable from the fork.
export const pullRequestCheckoutAllowed = Effect.fn("GitManager.pullRequestCheckoutAllowed")(
  function* (
    getParent: ForkUpstream["Service"]["getParent"],
    checkout: CheckoutRepository | undefined,
    target: Pick<CheckoutRepository, "host" | "repository"> & {
      readonly headRepositoryNameWithOwner?: string | null | undefined;
    },
  ) {
    if (
      checkout?.kind !== "github" ||
      checkout.host.toLowerCase() !== target.host.toLowerCase() ||
      checkout.repository.toLowerCase() === target.repository.toLowerCase() ||
      checkout.repository.toLowerCase() === target.headRepositoryNameWithOwner?.toLowerCase()
    ) {
      return true;
    }
    return yield* getParent(checkout).pipe(
      Effect.map((parent) => parent?.toLowerCase() !== target.repository.toLowerCase()),
      // Checkout fetches use the resolved PR's base or head repository even without parent metadata.
      Effect.orElseSucceed(() => true),
    );
  },
);
