import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  addToast: vi.fn(),
}));

vi.mock("./ui/toast", () => ({
  toastManager: { add: testState.addToast },
}));

import { showDesktopUpdateDownloadedToast } from "./desktopUpdate.toast";

function getReadMoreAction(): () => Promise<void> {
  const toast = testState.addToast.mock.calls[0]?.[0] as
    | { actionProps?: { onClick?: () => Promise<void> } }
    | undefined;
  const action = toast?.actionProps?.onClick;
  expect(action).toBeTypeOf("function");
  return action!;
}

describe("showDesktopUpdateDownloadedToast", () => {
  beforeEach(() => {
    testState.addToast.mockReset();
  });

  it("opens the downloaded version's release notes", async () => {
    const openExternal = vi.fn().mockResolvedValue(true);

    showDesktopUpdateDownloadedToast({ openExternal }, "0.0.30");
    await getReadMoreAction()();

    expect(openExternal).toHaveBeenCalledWith(
      "https://github.com/pingdotgg/t3code/releases/tag/v0.0.30",
    );
    expect(testState.addToast).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["returns false", vi.fn().mockResolvedValue(false)],
    ["rejects", vi.fn().mockRejectedValue(new Error("open failed"))],
  ])("shows an error when opening release notes %s", async (_description, openExternal) => {
    showDesktopUpdateDownloadedToast({ openExternal }, "0.0.30");
    await getReadMoreAction()();

    expect(testState.addToast).toHaveBeenLastCalledWith({
      type: "error",
      title: "Unable to open release notes",
    });
  });
});
