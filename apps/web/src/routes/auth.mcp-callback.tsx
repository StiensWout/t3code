import { useAtomValue } from "@effect/atom-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { clearMcpAuthDelivery, pendingMcpAuthDelivery } from "../mcpAuthDelivery";
import { useEnvironments } from "../state/environments";
import { mcpManagement } from "../state/mcpManagement";
import { useAtomCommand } from "../state/use-atom-command";

export const Route = createFileRoute("/auth/mcp-callback")({ component: McpCallback });

function McpCallback() {
  const [delivery] = useState(pendingMcpAuthDelivery);
  const { environments } = useEnvironments();
  const complete = useAtomCommand(mcpManagement.completeOAuth, {
    reportFailure: false,
    reportDefect: false,
  });
  const canComplete = useAtomValue(
    mcpManagement.completeOAuth.permissionAtom(delivery?.environmentId ?? null),
  );
  const connected = environments.some(
    (environment) =>
      environment.environmentId === delivery?.environmentId &&
      environment.connection.phase === "connected",
  );
  const [status, setStatus] = useState<"waiting" | "completing" | "done" | "failed">("waiting");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const started = useRef<number | null>(null);
  useEffect(() => {
    if (!delivery || !connected || !canComplete || started.current === attempt) return;
    started.current = attempt;
    setStatus("completing");
    setError(null);
    void complete({
      environmentId: delivery.environmentId,
      input: { id: delivery.id, callbackUrl: delivery.callbackUrl },
    })
      .then((result) => {
        if (result._tag === "Success") {
          clearMcpAuthDelivery();
          setStatus("done");
        } else if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(failure instanceof Error ? failure.message : "Could not finish MCP sign-in.");
          setStatus("failed");
        } else {
          setStatus("failed");
          setError("Sign-in was interrupted. Reconnect and retry.");
        }
      })
      .catch(() => {
        setError("Could not finish MCP sign-in.");
        setStatus("failed");
      });
  }, [attempt, canComplete, complete, connected, delivery]);
  return (
    <main className="mx-auto grid max-w-lg gap-4 p-8">
      <h1 className="text-lg font-medium">MCP sign-in</h1>
      <p role="status" className="text-sm">
        {!delivery
          ? "This sign-in callback is missing or expired. Return to MCP settings and start again."
          : status === "done"
            ? "Signed in. You can close this tab."
            : status === "completing"
              ? "Finishing sign-in..."
              : status === "failed"
                ? error
                : connected && !canComplete
                  ? "This session needs provider management permission to finish sign-in."
                  : "Waiting for the destination environment to connect..."}
      </p>
      {status === "failed" ? (
        <Button
          size="sm"
          disabled={!connected || !canComplete}
          onClick={() => setAttempt((value) => value + 1)}
        >
          Retry
        </Button>
      ) : null}
      <Link
        to="/settings/providers"
        hash="mcp-servers"
        search={delivery ? { environmentId: delivery.environmentId } : {}}
        className="text-sm underline"
      >
        Return to MCP settings
      </Link>
    </main>
  );
}
