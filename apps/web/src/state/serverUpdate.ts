import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";

/**
 * The npm install on the server side is capped at 10 minutes; expire the
 * pending state a bit beyond that so a dead transport never leaves the client
 * presenting an update indefinitely.
 */
export const SERVER_UPDATE_PENDING_EXPIRY_MS = 12 * 60_000;

export interface PendingServerUpdate {
  readonly attempt: number;
  readonly phase: "requesting" | "restarting" | "interrupted";
  readonly targetVersion: string;
}

const pendingServerUpdatesAtom = Atom.make<ReadonlyMap<EnvironmentId, PendingServerUpdate>>(
  new Map(),
).pipe(Atom.keepAlive, Atom.withLabel("server-update:pending"));

const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let nextAttempt = 0;

function clearExpiryTimer(environmentId: EnvironmentId): void {
  const timer = expiryTimers.get(environmentId);
  if (timer === undefined) return;
  clearTimeout(timer);
  expiryTimers.delete(environmentId);
}

function armExpiry(environmentId: EnvironmentId, attempt: number): void {
  clearExpiryTimer(environmentId);
  expiryTimers.set(
    environmentId,
    setTimeout(() => {
      clearPendingServerUpdate(environmentId, attempt);
    }, SERVER_UPDATE_PENDING_EXPIRY_MS),
  );
}

export function beginPendingServerUpdate(
  environmentId: EnvironmentId,
  targetVersion: string,
): number | null {
  const current = appAtomRegistry.get(pendingServerUpdatesAtom).get(environmentId);
  if (current && current.phase !== "interrupted") return null;

  const attempt = ++nextAttempt;
  const updates = new Map(appAtomRegistry.get(pendingServerUpdatesAtom));
  updates.set(environmentId, { attempt, phase: "requesting", targetVersion });
  appAtomRegistry.set(pendingServerUpdatesAtom, updates);
  armExpiry(environmentId, attempt);
  return attempt;
}

export function markPendingServerUpdateRestartAccepted(
  environmentId: EnvironmentId,
  attempt: number,
): void {
  const updates = appAtomRegistry.get(pendingServerUpdatesAtom);
  const current = updates.get(environmentId);
  if (current?.attempt !== attempt) return;

  const next = new Map(updates);
  next.set(environmentId, { ...current, phase: "restarting" });
  appAtomRegistry.set(pendingServerUpdatesAtom, next);
  armExpiry(environmentId, attempt);
}

export function markPendingServerUpdateInterrupted(
  environmentId: EnvironmentId,
  attempt: number,
): void {
  const updates = appAtomRegistry.get(pendingServerUpdatesAtom);
  const current = updates.get(environmentId);
  if (current?.attempt !== attempt) return;

  const next = new Map(updates);
  next.set(environmentId, { ...current, phase: "interrupted" });
  appAtomRegistry.set(pendingServerUpdatesAtom, next);
}

export function clearPendingServerUpdate(environmentId: EnvironmentId, attempt: number): void {
  const updates = appAtomRegistry.get(pendingServerUpdatesAtom);
  if (updates.get(environmentId)?.attempt !== attempt) return;

  clearExpiryTimer(environmentId);
  const next = new Map(updates);
  next.delete(environmentId);
  appAtomRegistry.set(pendingServerUpdatesAtom, next);
}

export function reconcilePendingServerUpdates(
  serverConfigs: ReadonlyMap<
    EnvironmentId,
    { readonly environment: { readonly serverVersion: string } }
  >,
): void {
  for (const [environmentId, update] of appAtomRegistry.get(pendingServerUpdatesAtom)) {
    const serverVersion = serverConfigs.get(environmentId)?.environment.serverVersion.trim();
    if (serverVersion && serverVersion === update.targetVersion.trim()) {
      clearPendingServerUpdate(environmentId, update.attempt);
    }
  }
}

export function usePendingServerUpdate(
  environmentId: EnvironmentId | null,
): PendingServerUpdate | null {
  const updates = useAtomValue(pendingServerUpdatesAtom);
  return environmentId === null ? null : (updates.get(environmentId) ?? null);
}

export function usePendingServerUpdates(): ReadonlyMap<EnvironmentId, PendingServerUpdate> {
  return useAtomValue(pendingServerUpdatesAtom);
}

export function getPendingServerUpdateForTests(
  environmentId: EnvironmentId,
): PendingServerUpdate | null {
  return appAtomRegistry.get(pendingServerUpdatesAtom).get(environmentId) ?? null;
}

export function resetPendingServerUpdatesForTests(): void {
  for (const timer of expiryTimers.values()) {
    clearTimeout(timer);
  }
  expiryTimers.clear();
  nextAttempt = 0;
  appAtomRegistry.set(pendingServerUpdatesAtom, new Map());
}
