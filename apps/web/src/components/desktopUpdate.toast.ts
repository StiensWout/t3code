import type { DesktopBridge } from "@t3tools/contracts";

import { getDesktopUpdateReleaseUrl } from "./desktopUpdate.logic";
import { toastManager } from "./ui/toast";

export function showDesktopUpdateDownloadedToast(
  shell: Pick<DesktopBridge, "openExternal">,
  downloadedVersion: string | null,
): void {
  const releaseUrl = getDesktopUpdateReleaseUrl(downloadedVersion);
  toastManager.add({
    type: "success",
    title: "Update downloaded",
    description: "Restart the app from the update button to install it.",
    ...(releaseUrl
      ? {
          actionProps: {
            children: "Read more",
            onClick: () => void shell.openExternal(releaseUrl),
          },
          data: { actionVariant: "link" as const },
        }
      : {}),
  });
}
