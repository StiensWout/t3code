import {
  createAssetEnvironmentAtoms,
  createProjectFaviconUrlAtomFamily,
} from "@t3tools/client-runtime/state/assets";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSession } from "./session";

export const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime);

export const projectFaviconUrlAtom = createProjectFaviconUrlAtomFamily({
  createUrl: assetEnvironment.createUrl,
  preparedConnection: environmentSession.preparedConnectionValueAtom,
});
