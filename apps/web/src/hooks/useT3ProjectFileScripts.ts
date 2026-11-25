import {
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type T3ProjectFile,
  type T3ProjectFileScript,
} from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";
import { readT3ProjectFile } from "~/lib/t3ProjectFileDefaults";
import { useFilesystemReadAccess } from "~/state/filesystem";

const NO_SCRIPTS: ReadonlyArray<T3ProjectFileScript> = [];

export interface T3ProjectFileState {
  status: "loading" | "missing" | "invalid" | "valid";
  file: T3ProjectFile | null;
  scripts: ReadonlyArray<T3ProjectFileScript>;
  refreshScripts: () => Promise<ReadonlyArray<T3ProjectFileScript>>;
}

export function useT3ProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): T3ProjectFileState {
  const query = useProjectFileQuery(environmentId, cwd ?? "", T3_PROJECT_FILE_NAME, cwd !== null);
  const { canReadFiles } = useFilesystemReadAccess(environmentId);
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  const refreshScripts = async () => {
    if (cwd === null || !canReadFiles) return NO_SCRIPTS;
    query.refresh();
    const file = await readT3ProjectFile(environmentId, cwd);
    return file?.scripts ?? NO_SCRIPTS;
  };
  if (contents === null) {
    return {
      status: isPending ? "loading" : "missing",
      file: null,
      scripts: NO_SCRIPTS,
      refreshScripts,
    } as const;
  }
  const file = parseT3ProjectFile(contents);
  if (file === null) {
    return { status: "invalid", file: null, scripts: NO_SCRIPTS, refreshScripts } as const;
  }
  return {
    status: "valid",
    file,
    scripts: file.scripts ?? NO_SCRIPTS,
    refreshScripts,
  } as const;
}
