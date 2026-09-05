import { SymbolView } from "./AppSymbol";
import { Image } from "expo-image";
import { useLayoutEffect, useMemo, useState } from "react";
import { View } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  getProjectFaviconResourceKey,
  isProjectFaviconFallbackUrl,
} from "@t3tools/shared/projectFavicon";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { projectFaviconUrlAtom } from "../state/assets";

import {
  beginProjectFaviconRequest,
  createProjectFaviconRequest,
  hasLoadedProjectFavicon,
  markProjectFaviconFailed,
  markProjectFaviconLoaded,
} from "./projectFaviconCache";

const EMPTY_FAVICON_URL = Atom.make<string | null>(null);

/* ─── Component ──────────────────────────────────────────────────────── */
export function ProjectFavicon(props: {
  readonly environmentId: EnvironmentId;
  readonly open?: boolean;
  readonly size?: number;
  readonly projectTitle: string;
  readonly workspaceRoot?: string | null;
  readonly faviconPath?: string | null;
}) {
  const size = props.size ?? 42;
  const faviconUrl = useAtomValue(
    props.workspaceRoot == null
      ? EMPTY_FAVICON_URL
      : projectFaviconUrlAtom({
          environmentId: props.environmentId,
          cwd: props.workspaceRoot,
          faviconPath: props.faviconPath,
        }),
  );
  const renderableFaviconUrl = isProjectFaviconFallbackUrl(faviconUrl) ? null : faviconUrl;
  const cacheKey =
    renderableFaviconUrl && props.workspaceRoot
      ? getProjectFaviconResourceKey(props.environmentId, props.workspaceRoot, props.faviconPath)
      : null;

  return (
    <ProjectFaviconImage
      key={cacheKey}
      cacheKey={cacheKey}
      faviconUrl={renderableFaviconUrl}
      open={props.open}
      projectTitle={props.projectTitle}
      size={size}
    />
  );
}

function ProjectFaviconImage(props: {
  readonly cacheKey: string | null;
  readonly faviconUrl: string | null;
  readonly open?: boolean;
  readonly projectTitle: string;
  readonly size: number;
}) {
  const faviconRequest = useMemo(
    () => createProjectFaviconRequest(props.cacheKey, props.faviconUrl),
    [props.cacheKey, props.faviconUrl],
  );
  const [activeFaviconRequest, setActiveFaviconRequest] = useState<typeof faviconRequest>(null);
  useLayoutEffect(() => {
    if (faviconRequest === null) return;

    const endRequest = beginProjectFaviconRequest(faviconRequest);
    setActiveFaviconRequest(faviconRequest);
    return endRequest;
  }, [faviconRequest]);

  const [status, setStatus] = useState<"loading" | "loaded" | "error">(() =>
    props.faviconUrl?.startsWith("data:image/") || hasLoadedProjectFavicon(props.cacheKey)
      ? "loaded"
      : "loading",
  );

  const requestIsActive = faviconRequest !== null && activeFaviconRequest === faviconRequest;
  const showImage = requestIsActive && status === "loaded";

  return (
    <View
      style={{
        width: props.size,
        height: props.size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* Folder icon fallback (matches web's FolderIcon) */}
      {!showImage ? (
        <SymbolView
          name={{ ios: "folder.fill", android: props.open ? "folder_open" : "folder" }}
          size={props.size * 0.78}
          tintColorClassName={"accent-icon-subtle"}
          type="monochrome"
        />
      ) : null}

      {/* Favicon image (hidden until loaded) */}
      {requestIsActive ? (
        <Image
          key={faviconRequest.faviconUrl}
          source={{
            uri: faviconRequest.faviconUrl,
          }}
          cachePolicy={
            faviconRequest.faviconUrl.startsWith("data:image/") ? "memory" : "memory-disk"
          }
          recyclingKey={faviconRequest.cacheKey}
          accessibilityLabel={`${props.projectTitle} favicon`}
          style={{
            width: props.size,
            height: props.size,
            borderRadius: props.size * 0.16,
            ...(showImage ? {} : { position: "absolute" as const, opacity: 0 }),
          }}
          contentFit="contain"
          onLoad={() => {
            if (!markProjectFaviconLoaded(faviconRequest)) return;
            setStatus("loaded");
          }}
          onError={() => {
            if (!markProjectFaviconFailed(faviconRequest)) return;
            setStatus("error");
          }}
        />
      ) : null}
    </View>
  );
}
