import {
  ArchiveIcon,
  ArchiveX,
  DownloadIcon,
  InfoIcon,
  LoaderIcon,
  MoonIcon,
  PlusIcon,
  RefreshCwIcon,
  SettingsIcon,
  SunIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { ChangeEvent, CSSProperties, UIEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  defaultInstanceIdForDriver,
  type BackgroundActivityProfile,
  type BackgroundActivitySettings,
  type DesktopUpdateChannel,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ScopedThreadRef,
  type SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
  DEFAULT_UNIFIED_SETTINGS,
  type EnvironmentIdentificationMode,
  MAX_GLASS_OPACITY,
  MIN_GLASS_OPACITY,
} from "@t3tools/contracts/settings";
import {
  getBackgroundActivityBaseProfile,
  getBackgroundActivityPresetSettings,
  resolveServerBackgroundActivitySettings,
} from "@t3tools/shared/backgroundActivitySettings";
import { createModelSelection } from "@t3tools/shared/model";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Result from "effect/Result";
import { APP_VERSION, HOSTED_APP_CHANNEL, HOSTED_APP_CHANNEL_LABEL } from "../../branding";
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../../components/desktopUpdate.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import {
  resolveEnvironmentIdentificationPillLabel,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { isElectron } from "../../env";
import { buildHostedChannelSelectionUrl, type HostedAppChannel } from "../../hostedPairing";
import { useCustomThemes } from "../../hooks/useCustomThemes";
import { useTheme } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import {
  THEME_COLOR_ROLES,
  THEME_FILE_VERSION,
  getThemeColorsForMode,
  getThemeDefinition,
  getThemeModes,
  getThemePreferenceMode,
  installCustomTheme,
  parseThemeFile,
  removeCustomTheme,
  serializeThemeFile,
  themePreferenceForMode,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeDefinition,
  T3_CHAT_DARK_THEME,
  T3_CHAT_THEME,
} from "../../themePalette";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import {
  primaryServerObservabilityAtom,
  primaryServerProvidersAtom,
  serverEnvironment,
} from "../../state/server";
import { usePrimaryEnvironment } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { formatRelativeTimeLabel, getRelativeTimeState } from "../../timestampFormat";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  hasOneClickUpdateProviderCandidate,
  isProviderUpdateActive,
  type ProviderUpdateCandidate,
} from "../ProviderUpdateLaunchNotification.logic";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { DRIVER_OPTIONS, getDriverOption } from "./providerDriverMeta";
import {
  backgroundActivitySharedPolicySettings,
  buildProviderInstanceUpdatePatch,
  formatDiagnosticsDescription,
  hasChangedBackgroundActivitySettings,
  isProjectGroupingEnabled,
  projectGroupingModeFromToggle,
  readLastEnabledProjectGroupingMode,
  rememberEnabledProjectGroupingMode,
  resolveBackgroundActivityProfileOption,
} from "./SettingsPanels.logic";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { ProjectFavicon } from "../ProjectFavicon";
import { useAtomCommand } from "../../state/use-atom-command";

const ENVIRONMENT_IDENTIFICATION_LABELS: Record<EnvironmentIdentificationMode, string> = {
  artwork: "Artwork",
  pill: "Version pill",
  none: "None",
};

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

const BACKGROUND_ACTIVITY_PROFILE_LABELS: Record<BackgroundActivityProfile, string> = {
  balanced: "Balanced",
  performance: "Performance",
  "battery-saver": "Battery saver",
};

type BackgroundActivityProfileOption = BackgroundActivityProfile | "advanced";
type BackgroundActivityOverridePatch = Partial<{
  [K in keyof BackgroundActivitySettings["overrides"]]:
    | BackgroundActivitySettings["overrides"][K]
    | undefined;
}>;

const BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS: Record<BackgroundActivityProfileOption, string> = {
  ...BACKGROUND_ACTIVITY_PROFILE_LABELS,
  advanced: "Advanced",
};

const BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS: Record<BackgroundActivityProfile, string> = {
  balanced:
    "Pauses background probes when clients are idle, the host is locked, or low power mode is active.",
  performance: "Allows scoped background probes while any subscribed client remains connected.",
  "battery-saver": "Also pauses background probes when the host or client is on battery.",
};

const ADVANCED_BACKGROUND_ACTIVITY_DESCRIPTION =
  "Uses custom background intervals with the selected shared power policy.";

const PROVIDER_HEALTH_INTERVAL_STEP_SECONDS = 30;
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const BACKGROUND_ACTIVITY_BOOLEAN_OVERRIDES: ReadonlyArray<{
  readonly key:
    | "pauseWhenHostLocked"
    | "pauseWhenHostLowPower"
    | "pauseWhenClientLowPower"
    | "pauseWhenOnBattery";
  readonly label: string;
}> = [
  { key: "pauseWhenHostLocked", label: "Pause when host is locked" },
  { key: "pauseWhenHostLowPower", label: "Pause on host low power" },
  { key: "pauseWhenClientLowPower", label: "Pause on client low power" },
  { key: "pauseWhenOnBattery", label: "Pause on battery" },
];

function durationToSeconds(duration: Duration.Duration): number {
  return Math.round(Duration.toMillis(duration) / 1_000);
}

function normalizeIntervalSeconds(value: number | null, minimum = 0): number {
  if (value === null || !Number.isFinite(value)) {
    return minimum;
  }
  return Math.max(minimum, Math.round(value));
}

function resetBackgroundActivitySettings() {
  return {
    backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  };
}

function backgroundActivityProfileSettings(profile: BackgroundActivityProfile) {
  return {
    backgroundActivity: {
      schemaVersion: 1 as const,
      profile,
      overrides: {},
    },
  };
}

function backgroundActivityOverrideSettings(
  current: BackgroundActivitySettings,
  resolved: ReturnType<typeof resolveServerBackgroundActivitySettings>,
  overrides: BackgroundActivityOverridePatch,
) {
  const nextOverrides: BackgroundActivityOverridePatch = {
    automaticGitFetchInterval: resolved.automaticGitFetchInterval,
    providerHealthRefreshInterval: resolved.providerHealthRefreshInterval,
    hostPowerMonitorActiveInterval: resolved.hostPowerMonitorActiveInterval,
    hostPowerMonitorIdleInterval: resolved.hostPowerMonitorIdleInterval,
    idleClientTtl: resolved.idleClientTtl,
    pauseWhenHostLocked: resolved.pauseWhenHostLocked,
    pauseWhenHostLowPower: resolved.pauseWhenHostLowPower,
    pauseWhenClientLowPower: resolved.pauseWhenClientLowPower,
    pauseWhenOnBattery: resolved.pauseWhenOnBattery,
    ...overrides,
  };
  for (const [key, value] of Object.entries(nextOverrides)) {
    if (value === undefined) {
      delete nextOverrides[key as keyof typeof nextOverrides];
    }
  }
  return {
    backgroundActivity: {
      schemaVersion: 1 as const,
      profile: "custom" as const,
      baseProfile: getBackgroundActivityBaseProfile(current),
      overrides: nextOverrides as BackgroundActivitySettings["overrides"],
    },
  };
}

function PolicyTooltip({ children }: { readonly children: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
            aria-label="Background policy details"
          >
            <InfoIcon className="size-3.5" />
          </button>
        }
      />
      <TooltipPopup side="top" className="max-w-72">
        {children}
      </TooltipPopup>
    </Tooltip>
  );
}

function withoutProviderInstanceKey<V>(
  record: Readonly<Record<ProviderInstanceId, V>> | undefined,
  key: ProviderInstanceId,
): Record<ProviderInstanceId, V> {
  const next = { ...record } as Record<ProviderInstanceId, V>;
  delete next[key];
  return next;
}

function withoutProviderInstanceFavorites(
  favorites: ReadonlyArray<{ readonly provider: ProviderInstanceId; readonly model: string }>,
  instanceId: ProviderInstanceId,
) {
  return favorites.filter((favorite) => favorite.provider !== instanceId);
}

const PROVIDER_SETTINGS = DRIVER_OPTIONS.map((definition) => ({
  provider: definition.value,
}));

function ProviderLastChecked({ lastCheckedAt }: { lastCheckedAt: string | null }) {
  useRelativeTimeTick();
  const lastCheckedRelative = getRelativeTimeState(lastCheckedAt);

  if (lastCheckedRelative.status === "missing") {
    return null;
  }

  if (lastCheckedRelative.status === "invalid") {
    return <span className="text-[11px] text-muted-foreground/50">Checked unavailable</span>;
  }

  return (
    <span className="text-[11px] text-muted-foreground/60">
      {lastCheckedRelative.suffix ? (
        <>
          Checked <span className="font-mono tabular-nums">{lastCheckedRelative.value}</span>{" "}
          {lastCheckedRelative.suffix}
        </>
      ) : (
        <>Checked {lastCheckedRelative.value}</>
      )}
    </span>
  );
}

function AboutVersionTitle() {
  return (
    <span className="inline-flex items-center gap-2">
      <span>Version</span>
      <code className="text-[11px] font-medium text-muted-foreground">{APP_VERSION}</code>
    </span>
  );
}

function AboutVersionSection() {
  const updateState = useDesktopUpdateState();
  const [isChangingUpdateChannel, setIsChangingUpdateChannel] = useState(false);

  const hasDesktopBridge = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const selectedUpdateChannel = updateState?.channel ?? "latest";
  const selectedHostedAppChannel = hasDesktopBridge ? null : HOSTED_APP_CHANNEL;

  const handleUpdateChannelChange = useCallback(
    (channel: DesktopUpdateChannel) => {
      const bridge = window.desktopBridge;
      if (
        !bridge ||
        typeof bridge.setUpdateChannel !== "function" ||
        channel === selectedUpdateChannel
      ) {
        return;
      }

      setIsChangingUpdateChannel(true);
      void bridge
        .setUpdateChannel(channel)
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not change update track",
              description: error instanceof Error ? error.message : "Update track change failed.",
            }),
          );
        })
        .finally(() => {
          setIsChangingUpdateChannel(false);
        });
    },
    [selectedUpdateChannel],
  );

  const handleButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";

    if (action === "download") {
      void bridge.downloadUpdate().catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not download update",
            description: error instanceof Error ? error.message : "Download failed.",
          }),
        );
      });
      return;
    }

    if (action === "install") {
      const confirmed = window.confirm(
        getDesktopUpdateInstallConfirmationMessage(
          updateState ?? { availableVersion: null, downloadedVersion: null },
          navigator.platform,
        ),
      );
      if (!confirmed) return;
      void bridge.installUpdate().catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "Install failed.",
          }),
        );
      });
      return;
    }

    if (typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        if (!result.checked) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not check for updates",
              description:
                result.state.message ?? "Automatic updates are not available in this build.",
            }),
          );
        }
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "Update check failed.",
          }),
        );
      });
  }, [updateState]);

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  const buttonDisabled =
    action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState);

  const actionLabel: Record<string, string> = { download: "Download", install: "Install" };
  const statusLabel: Record<string, string> = {
    checking: "Checking…",
    downloading: "Downloading…",
    "up-to-date": "Up to Date",
  };
  const buttonLabel =
    actionLabel[action] ?? statusLabel[updateState?.status ?? ""] ?? "Check for Updates";
  const description =
    action === "download" || action === "install"
      ? "Update available."
      : "Current version of the application.";

  return (
    <>
      <SettingsRow
        title={<AboutVersionTitle />}
        description={description}
        control={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant={action === "install" ? "default" : "outline"}
                  disabled={buttonDisabled}
                  onClick={handleButtonClick}
                >
                  {buttonLabel}
                </Button>
              }
            />
            {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
          </Tooltip>
        }
      />
      {hasDesktopBridge ? (
        <SettingsRow
          title="Update track"
          description="Stable follows full releases. Nightly follows the nightly desktop channel and can switch back to stable immediately."
          control={
            <Select
              value={selectedUpdateChannel}
              onValueChange={(value) => {
                handleUpdateChannelChange(value as DesktopUpdateChannel);
              }}
            >
              <SelectTrigger
                className="w-full sm:w-40"
                aria-label="Update track"
                disabled={isChangingUpdateChannel}
              >
                <SelectValue>
                  {selectedUpdateChannel === "nightly" ? "Nightly" : "Stable"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  Stable
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  Nightly
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : selectedHostedAppChannel ? (
        <SettingsRow
          title="Update track"
          description="Switches the hosted app release channel."
          control={
            <Select
              value={selectedHostedAppChannel}
              onValueChange={(value) => {
                if (value === selectedHostedAppChannel) return;
                window.location.assign(
                  buildHostedChannelSelectionUrl({ channel: value as HostedAppChannel }),
                );
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Update track">
                <SelectValue>{HOSTED_APP_CHANNEL_LABEL}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  Latest
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  Nightly
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
    </>
  );
}

export function useSettingsRestore(onRestored?: () => void) {
  const { theme, setTheme } = useTheme();
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const isBackgroundActivityDirty = hasChangedBackgroundActivitySettings(settings);

  const changedSettingLabels = useMemo(
    () => [
      ...(theme !== "system" ? ["Theme"] : []),
      ...(settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity ? ["Glass opacity"] : []),
      ...(settings.environmentIdentificationMode !==
      DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode
        ? ["Environment identification"]
        : []),
      ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
        ? ["Time format"]
        : []),
      ...(settings.sidebarThreadPreviewCount !== DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount
        ? ["Visible threads"]
        : []),
      ...(settings.sidebarProjectGroupingMode !==
      DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode
        ? ["Project Grouping"]
        : []),
      ...(settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? ["Word wrap"] : []),
      ...(settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace
        ? ["Diff whitespace changes"]
        : []),
      ...(settings.autoOpenPlanSidebar !== DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar
        ? ["Auto-open task panel"]
        : []),
      ...(settings.enableAssistantStreaming !== DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming
        ? ["Assistant output"]
        : []),
      ...(settings.enableProviderUpdateChecks !==
      DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks
        ? ["Provider update checks"]
        : []),
      ...(isBackgroundActivityDirty ? ["Background activity"] : []),
      ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
        ? ["New thread mode"]
        : []),
      ...(settings.newWorktreesStartFromOrigin !==
      DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin
        ? ["New worktrees start from origin"]
        : []),
      ...(settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory
        ? ["Add project base directory"]
        : []),
      ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
        ? ["Archive confirmation"]
        : []),
      ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
        ? ["Delete confirmation"]
        : []),
      ...(isTextGenerationModelDirty ? ["Text generation model"] : []),
    ],
    [
      isTextGenerationModelDirty,
      isBackgroundActivityDirty,
      settings.autoOpenPlanSidebar,
      settings.confirmThreadArchive,
      settings.confirmThreadDelete,
      settings.addProjectBaseDirectory,
      settings.defaultThreadEnvMode,
      settings.newWorktreesStartFromOrigin,
      settings.diffIgnoreWhitespace,
      settings.environmentIdentificationMode,
      settings.glassOpacity,
      settings.enableAssistantStreaming,
      settings.enableProviderUpdateChecks,
      settings.sidebarProjectGroupingMode,
      settings.sidebarThreadPreviewCount,
      settings.timestampFormat,
      settings.wordWrap,
      theme,
    ],
  );

  const restoreDefaults = useCallback(async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readLocalApi();
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      ["Restore default settings?", `This will reset: ${changedSettingLabels.join(", ")}.`].join(
        "\n",
      ),
    );
    if (!confirmed) return;

    setTheme("system");
    updateSettings({
      timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
      wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap,
      diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
      environmentIdentificationMode: DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode,
      glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity,
      sidebarThreadPreviewCount: DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount,
      sidebarProjectGroupingMode: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
      autoOpenPlanSidebar: DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar,
      enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
      enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
      backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
      backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
      automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
      providerHealthRefreshInterval: DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
      defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
      newWorktreesStartFromOrigin: DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
      addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
      confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
      confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
      textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
    });
    onRestored?.();
  }, [changedSettingLabels, onRestored, setTheme, updateSettings]);

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

function BackgroundActivityAdvancedDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const activeProfile = resolvedBackgroundActivity.profile;
  const automaticGitFetchIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.automaticGitFetchInterval,
  );
  const providerHealthRefreshIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.providerHealthRefreshInterval,
  );
  const hostPowerMonitorActiveIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.hostPowerMonitorActiveInterval,
  );
  const hostPowerMonitorIdleIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.hostPowerMonitorIdleInterval,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Background Activity</DialogTitle>
          <DialogDescription>
            Tune the shared power policy and the background intervals that feed it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-0 px-6 pb-5">
          <div className="overflow-hidden rounded-xl border bg-card text-card-foreground">
            <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">Shared policy</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Controls whether background work may run after a subscribed interval fires.
                </p>
              </div>
              <Select
                value={activeProfile}
                onValueChange={(value) => {
                  if (
                    value === "balanced" ||
                    value === "performance" ||
                    value === "battery-saver"
                  ) {
                    updateSettings({
                      backgroundActivity: backgroundActivitySharedPolicySettings(settings, value),
                    });
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-40" aria-label="Shared background policy">
                  <SelectValue>{BACKGROUND_ACTIVITY_PROFILE_LABELS[activeProfile]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="balanced">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS.balanced}
                  </SelectItem>
                  <SelectItem hideIndicator value="performance">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS.performance}
                  </SelectItem>
                  <SelectItem hideIndicator value="battery-saver">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS["battery-saver"]}
                  </SelectItem>
                </SelectPopup>
              </Select>
            </div>

            <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">Git fetch interval</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Refresh remote branch status in the background.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={automaticGitFetchIntervalSeconds}
                  min={0}
                  step={5}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          automaticGitFetchInterval: Duration.seconds(
                            normalizeIntervalSeconds(value),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="Decrease Git fetch interval" />
                    <NumberFieldInput aria-label="Git fetch interval in seconds" />
                    <NumberFieldIncrement aria-label="Increase Git fetch interval" />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">seconds</span>
              </div>
            </div>

            <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">Provider health interval</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Refresh provider availability, versions, auth state, and model metadata.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={providerHealthRefreshIntervalSeconds}
                  min={0}
                  step={PROVIDER_HEALTH_INTERVAL_STEP_SECONDS}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          providerHealthRefreshInterval: Duration.seconds(
                            normalizeIntervalSeconds(value),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="Decrease provider health interval" />
                    <NumberFieldInput aria-label="Provider health interval in seconds" />
                    <NumberFieldIncrement aria-label="Increase provider health interval" />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">seconds</span>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">Host power monitor</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Poll host power state while clients are active.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={hostPowerMonitorActiveIntervalSeconds}
                  min={5}
                  step={5}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          hostPowerMonitorActiveInterval: Duration.seconds(
                            normalizeIntervalSeconds(value, 5),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="Decrease active host power interval" />
                    <NumberFieldInput aria-label="Active host power interval in seconds" />
                    <NumberFieldIncrement aria-label="Increase active host power interval" />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">seconds</span>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">Idle host monitor</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Poll host power state when no foreground client is active.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={hostPowerMonitorIdleIntervalSeconds}
                  min={5}
                  step={30}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          hostPowerMonitorIdleInterval: Duration.seconds(
                            normalizeIntervalSeconds(value, 5),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="Decrease idle host power interval" />
                    <NumberFieldInput aria-label="Idle host power interval in seconds" />
                    <NumberFieldIncrement aria-label="Increase idle host power interval" />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">seconds</span>
              </div>
            </div>

            <div className="grid gap-0 border-t sm:grid-cols-2">
              {BACKGROUND_ACTIVITY_BOOLEAN_OVERRIDES.map(({ key, label }) => (
                <label
                  key={key}
                  className="flex items-center justify-between gap-3 border-b px-4 py-3 last:border-b-0 sm:border-r sm:even:border-r-0"
                >
                  <span className="text-sm font-medium">{label}</span>
                  <Switch
                    checked={resolvedBackgroundActivity[key]}
                    onCheckedChange={(checked) =>
                      updateSettings(
                        backgroundActivityOverrideSettings(
                          settings.backgroundActivity,
                          resolvedBackgroundActivity,
                          {
                            [key]: Boolean(checked),
                          },
                        ),
                      )
                    }
                    aria-label={label}
                  />
                </label>
              ))}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => updateSettings(resetBackgroundActivitySettings())}
          >
            Reset all
          </Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const THEME_PREVIEW_ROLES = [
  "sidebar",
  "canvas",
  "surface",
  "accentSurface",
  "accent",
  "messageSurface",
  "messageAction",
] as const;
type ThemePreviewRole = (typeof THEME_PREVIEW_ROLES)[number];
type ThemeCardPreview = {
  mode: ThemeAppearance;
  colors: Readonly<Record<ThemePreviewRole, string>>;
};
type ThemeCardDefinition = {
  id: string;
  label: string;
  previews: ReadonlyArray<ThemeCardPreview>;
};

const STANDARD_THEME_PREVIEW_COLORS: Record<
  ThemeAppearance,
  Readonly<Record<ThemePreviewRole, string>>
> = {
  light: {
    sidebar: "#fafafa",
    canvas: "#fcfcfc",
    surface: "#ffffff",
    accentSurface: "#f4f4f5",
    accent: "#f4f4f5",
    messageSurface: "#e4e4e7",
    messageAction: "#4f46e5",
  },
  dark: {
    sidebar: "#0f0f10",
    canvas: "#0a0a0a",
    surface: "#121212",
    accentSurface: "#27272a",
    accent: "#1c1c1f",
    messageSurface: "#27272a",
    messageAction: "#8b9cff",
  },
};

function getStandardThemeCards(): ReadonlyArray<ThemeCardDefinition> {
  return [
    {
      id: "default",
      label: "Default",
      previews: (["light", "dark"] as const).map((mode) => ({
        mode,
        colors: STANDARD_THEME_PREVIEW_COLORS[mode],
      })),
    },
  ];
}

function getThemeCardDefinition(theme: ThemeDefinition): ThemeCardDefinition {
  return {
    id: theme.id,
    label: theme.label,
    previews: getThemeModes(theme).map((mode) => {
      const colors = getThemeColorsForMode(theme, mode) ?? theme.colors;
      return {
        mode,
        colors: {
          sidebar: colors.sidebar,
          canvas: colors.canvas,
          surface: colors.surface,
          accentSurface: colors.accentSurface,
          accent: colors.accent,
          messageSurface: colors.messageSurface,
          messageAction: colors.messageAction,
        },
      };
    }),
  };
}

const THEME_EDITOR_PRIMARY_ROLES: ReadonlyArray<ThemeColorRole> = [
  "canvas",
  "chrome",
  "sidebar",
  "surface",
  "text",
  "textMuted",
  "placeholder",
  "secondaryLabel",
  "iconMuted",
  "accent",
  "messageSurface",
  "messageAction",
];

const THEME_EDITOR_ADVANCED_ROLES = THEME_COLOR_ROLES.filter(
  (role) => !THEME_EDITOR_PRIMARY_ROLES.includes(role),
);

type ThemeEditorColors = Record<ThemeColorRole, string>;
type ThemeEditorModeSelection = "single" | "both";
type ThemeEditorColorsByAppearance = Record<ThemeAppearance, ThemeEditorColors>;

function getThemeEditorDefaults(appearance: ThemeAppearance): ThemeEditorColors {
  return {
    ...(appearance === "dark" ? T3_CHAT_DARK_THEME.colors : T3_CHAT_THEME.colors),
  };
}

function getThemeEditorColorsByAppearance(): ThemeEditorColorsByAppearance {
  return {
    light: getThemeEditorDefaults("light"),
    dark: getThemeEditorDefaults("dark"),
  };
}

function getThemeRoleLabel(role: ThemeColorRole): string {
  return role.replace(/([A-Z])/g, " $1").replace(/^./, (character) => character.toUpperCase());
}

function ThemeColorField({
  role,
  value,
  onChange,
}: {
  role: ThemeColorRole;
  value: string;
  onChange: (value: string) => void;
}) {
  const label = getThemeRoleLabel(role);
  const pickerValue = /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";

  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border/70 bg-background/40 px-3 py-2">
      <label className="min-w-0 flex-1 text-sm leading-snug" htmlFor={`${role}-hex`}>
        {label}
      </label>
      <div className="flex shrink-0 items-center gap-2">
        <input
          aria-label={`Choose ${label} color`}
          className="size-7 cursor-pointer rounded-md border border-border bg-transparent p-0.5"
          onChange={(event) => onChange(event.currentTarget.value)}
          type="color"
          value={pickerValue}
        />
        <Input
          aria-label={`${label} hex value`}
          className="w-28"
          id={`${role}-hex`}
          onChange={(event) => onChange(event.currentTarget.value)}
          size="sm"
          value={value}
        />
      </div>
    </div>
  );
}

function CreateThemeDialog({
  open,
  onOpenChange,
  onCreated,
  initialAppearance,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (theme: ThemeDefinition) => void;
  initialAppearance: ThemeAppearance;
}) {
  const [name, setName] = useState("");
  const [modeSelection, setModeSelection] = useState<ThemeEditorModeSelection>("single");
  const [activeAppearance, setActiveAppearance] = useState<ThemeAppearance>(initialAppearance);
  const [colorsByAppearance, setColorsByAppearance] = useState<ThemeEditorColorsByAppearance>(() =>
    getThemeEditorColorsByAppearance(),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setModeSelection("single");
    setActiveAppearance(initialAppearance);
    setColorsByAppearance(getThemeEditorColorsByAppearance());
    setError(null);
  }, [initialAppearance, open]);

  const updateColor = useCallback(
    (role: ThemeColorRole, value: string) => {
      setColorsByAppearance((current) => ({
        ...current,
        [activeAppearance]: { ...current[activeAppearance], [role]: value },
      }));
    },
    [activeAppearance],
  );

  const handleSubmit = useCallback(() => {
    if (!name.trim()) {
      setError("Give your theme a name before saving it.");
      return;
    }

    try {
      const variantAppearance = activeAppearance === "light" ? "dark" : "light";
      const variants =
        modeSelection === "both"
          ? { [variantAppearance]: colorsByAppearance[variantAppearance] }
          : undefined;
      const createdTheme = installCustomTheme(
        parseThemeFile({
          version: THEME_FILE_VERSION,
          name,
          appearance: activeAppearance,
          colors: colorsByAppearance[activeAppearance],
          ...(variants ? { variants } : {}),
        }),
      );
      onCreated(createdTheme);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the theme.");
    }
  }, [activeAppearance, colorsByAppearance, modeSelection, name, onCreated, onOpenChange]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setError(null);
        onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-3xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Create theme</DialogTitle>
          <DialogDescription>
            Pick a palette for T3 Code. Add a dark version if you need one.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <label className="block space-y-2">
            <span className="text-sm font-medium">Theme name</span>
            <Input
              autoFocus
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="e.g. Aurora"
              value={name}
            />
          </label>

          <div className="space-y-2">
            <span className="text-sm font-medium">Modes</span>
            <div aria-label="Modes" className="grid grid-cols-2 gap-2" role="group">
              <Button
                aria-pressed={modeSelection === "single"}
                variant={modeSelection === "single" ? "secondary" : "outline"}
                onClick={() => setModeSelection("single")}
              >
                One mode
              </Button>
              <Button
                aria-pressed={modeSelection === "both"}
                variant={modeSelection === "both" ? "secondary" : "outline"}
                onClick={() => setModeSelection("both")}
              >
                Light + dark
              </Button>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {modeSelection === "both"
                ? "Use a separate palette for light and dark mode."
                : "Use the same palette in both modes."}
            </p>
          </div>

          <div className="space-y-2">
            <span className="text-sm font-medium">
              {modeSelection === "both" ? "Colors" : "Appearance"}
            </span>
            <div aria-label="Theme appearance" className="grid grid-cols-2 gap-2" role="group">
              <Button
                aria-pressed={activeAppearance === "light"}
                variant={activeAppearance === "light" ? "secondary" : "outline"}
                onClick={() => setActiveAppearance("light")}
              >
                <SunIcon />
                Light
              </Button>
              <Button
                aria-pressed={activeAppearance === "dark"}
                variant={activeAppearance === "dark" ? "secondary" : "outline"}
                onClick={() => setActiveAppearance("dark")}
              >
                <MoonIcon />
                Dark
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <div>
              <h3 className="text-sm font-medium">Main colors</h3>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Surfaces, text, accents, and message actions.
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {THEME_EDITOR_PRIMARY_ROLES.map((role) => (
                <ThemeColorField
                  key={role}
                  onChange={(value) => updateColor(role, value)}
                  role={role}
                  value={colorsByAppearance[activeAppearance][role]}
                />
              ))}
            </div>
          </div>

          <details className="group rounded-xl border border-border/70 bg-muted/20">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
              <span>Advanced colors</span>
              <span className="text-xs font-normal text-muted-foreground">
                {THEME_EDITOR_ADVANCED_ROLES.length} more roles
              </span>
            </summary>
            <div className="grid gap-2 border-t border-border/70 p-3 sm:grid-cols-2">
              {THEME_EDITOR_ADVANCED_ROLES.map((role) => (
                <ThemeColorField
                  key={role}
                  onChange={(value) => updateColor(role, value)}
                  role={role}
                  value={colorsByAppearance[activeAppearance][role]}
                />
              ))}
            </div>
          </details>

          {error ? (
            <div
              aria-live="polite"
              className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-sm text-destructive-foreground"
            >
              {error}
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!name.trim()} onClick={handleSubmit}>
            <PlusIcon />
            Create theme
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function escapeJsonHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}

function highlightJson(value: string): string {
  const tokenPattern =
    /"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g;
  let highlighted = "";
  let cursor = 0;

  for (const match of value.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    highlighted += escapeJsonHtml(value.slice(cursor, index));

    let tokenClass = "theme-json-number";
    if (token.startsWith('"')) {
      tokenClass = /^\s*:/.test(value.slice(index + token.length))
        ? "theme-json-key"
        : "theme-json-string";
    } else if (token === "true" || token === "false" || token === "null") {
      tokenClass = "theme-json-constant";
    }
    highlighted += `<span class="${tokenClass}">${escapeJsonHtml(token)}</span>`;
    cursor = index + token.length;
  }

  return highlighted + escapeJsonHtml(value.slice(cursor));
}

function ThemeJsonEditor({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const highlightRef = useRef<HTMLPreElement>(null);
  const highlightedJson = useMemo(() => highlightJson(value), [value]);

  const syncScroll = useCallback((event: UIEvent<HTMLTextAreaElement>) => {
    const highlightElement = highlightRef.current;
    if (!highlightElement) return;
    highlightElement.scrollTop = event.currentTarget.scrollTop;
    highlightElement.scrollLeft = event.currentTarget.scrollLeft;
  }, []);

  return (
    <div className="relative overflow-hidden rounded-xl border border-input bg-background shadow-xs/5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24">
      <pre
        ref={highlightRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words p-3 font-mono text-[12px] leading-5 text-foreground"
      >
        <code dangerouslySetInnerHTML={{ __html: highlightedJson }} />
      </pre>
      <textarea
        aria-label="Theme JSON"
        className="relative z-10 block min-h-72 w-full resize-y overflow-auto bg-transparent p-3 font-mono text-[12px] leading-5 text-transparent caret-foreground outline-none placeholder:text-muted-foreground selection:bg-accent/30 selection:text-transparent"
        id={id}
        onChange={(event) => onChange(event.currentTarget.value)}
        onScroll={syncScroll}
        placeholder={
          '{\n  "version": 1,\n  "name": "Aurora",\n  "appearance": "light",\n  "colors": { ... }\n}'
        }
        spellCheck={false}
        value={value}
      />
    </div>
  );
}

function ThemeImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (theme: ThemeDefinition) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [json, setJson] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isReading, setIsReading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setJson("");
    setFileName(null);
    setError(null);
  }, [open]);

  const handleFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;

    setIsReading(true);
    try {
      setJson(await file.text());
      setFileName(file.name);
      setError(null);
    } catch {
      setError("Could not read that file. Paste the JSON below instead.");
    } finally {
      setIsReading(false);
    }
  }, []);

  const handleSubmit = useCallback(() => {
    try {
      const installedTheme = installCustomTheme(parseThemeFile(JSON.parse(json)));
      onImported(installedTheme);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That theme file is invalid.");
    }
  }, [json, onImported, onOpenChange]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setError(null);
        onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-3xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Add a theme</DialogTitle>
          <DialogDescription>
            Choose a JSON file or paste one below. Both options use the same theme format.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border/80 bg-muted/20 px-3 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Theme file</p>
              <p className="truncate text-xs text-muted-foreground">
                {fileName ?? "Upload a .json file, or paste the contents below."}
              </p>
            </div>
            <Button
              disabled={isReading}
              size="sm"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
            >
              <UploadIcon />
              {isReading ? "Reading…" : "Choose JSON file"}
            </Button>
            <input
              ref={fileInputRef}
              accept=".json,application/json"
              className="sr-only"
              onChange={handleFileChange}
              type="file"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <label className="text-sm font-medium" htmlFor="theme-json-editor">
                Paste theme JSON
              </label>
              <span className="text-xs text-muted-foreground">JSON</span>
            </div>
            <ThemeJsonEditor id="theme-json-editor" onChange={setJson} value={json} />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Export a theme from T3 Code to get a complete file, then edit the colors you want.
            </p>
          </div>

          {error ? (
            <div
              aria-live="polite"
              className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-sm text-destructive-foreground"
            >
              {error}
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!json.trim() || isReading} onClick={handleSubmit}>
            <PlusIcon />
            Add theme
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function downloadThemeFile(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function ThemePreviewCircle({ colors }: { colors: ThemeCardPreview["colors"] }) {
  const gradient = [
    `radial-gradient(circle at 14% 18%, ${colors.sidebar} 0%, color-mix(in srgb, ${colors.sidebar} 68%, transparent) 28%, transparent 66%)`,
    `radial-gradient(circle at 86% 20%, ${colors.accentSurface} 0%, color-mix(in srgb, ${colors.accentSurface} 70%, transparent) 30%, transparent 68%)`,
    `radial-gradient(circle at 82% 84%, ${colors.messageAction} 0%, color-mix(in srgb, ${colors.messageAction} 62%, transparent) 24%, transparent 62%)`,
    `radial-gradient(circle at 18% 84%, ${colors.messageSurface} 0%, color-mix(in srgb, ${colors.messageSurface} 66%, transparent) 28%, transparent 66%)`,
    `linear-gradient(145deg, ${colors.canvas} 0%, ${colors.surface} 100%)`,
  ].join(", ");
  return (
    <span
      aria-hidden
      className="block size-14 shrink-0 rounded-full border-2 border-background shadow-sm"
      style={{ backgroundColor: colors.canvas, backgroundImage: gradient }}
    />
  );
}

function ThemePreviewCircles({
  activeMode,
  label,
  onSelectMode,
  previews,
}: {
  activeMode: ThemeAppearance | null;
  label: string;
  onSelectMode: ((mode: ThemeAppearance) => void) | undefined;
  previews: ThemeCardDefinition["previews"];
}) {
  return (
    <div className="flex min-h-16 items-center justify-center gap-2.5 px-3 pt-3">
      {previews.map((preview) => {
        const isActive = activeMode === preview.mode;
        const circle = <ThemePreviewCircle colors={preview.colors} />;
        if (!onSelectMode) {
          return (
            <span
              className="flex size-[68px] shrink-0 items-center justify-center"
              key={preview.mode}
            >
              {circle}
            </span>
          );
        }

        return (
          <button
            aria-label={`Use ${label} ${preview.mode} mode`}
            aria-pressed={isActive}
            className={cn(
              "relative flex size-[68px] shrink-0 cursor-pointer items-center justify-center rounded-full p-1 outline-none transition-transform focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
              !isActive && "hover:scale-105",
            )}
            key={preview.mode}
            onClick={(event) => {
              event.stopPropagation();
              onSelectMode(preview.mode);
            }}
            style={isActive ? { boxShadow: "inset 0 0 0 2px var(--ring)" } : undefined}
            type="button"
          >
            {circle}
          </button>
        );
      })}
    </div>
  );
}

function ThemeLibraryCard({
  theme,
  isActive,
  isPersonal,
  onUse,
  onUseMode,
  activeMode,
  onDownload,
  onRemove,
}: {
  theme: ThemeCardDefinition;
  isActive: boolean;
  isPersonal: boolean;
  onUse: () => void;
  onUseMode?: ((mode: ThemeAppearance) => void) | undefined;
  activeMode?: ThemeAppearance | null;
  onDownload?: () => void;
  onRemove?: () => void;
}) {
  return (
    <div
      className={cn(
        "cursor-pointer overflow-hidden rounded-xl border border-border/70 bg-card/60 transition-colors hover:bg-accent/10",
        isActive && "bg-accent/30",
      )}
      data-theme-library-card={theme.id}
      onClick={onUse}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onUse();
      }}
      role="button"
      style={isActive ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined}
      tabIndex={0}
    >
      <ThemePreviewCircles
        activeMode={isActive ? (activeMode ?? theme.previews[0]?.mode ?? null) : null}
        label={theme.label}
        onSelectMode={onUseMode}
        previews={theme.previews}
      />
      <div className="flex items-center gap-2 px-3 pb-3 pt-2">
        <button
          aria-label={`${theme.label} theme${isActive ? ", currently active" : ""}`}
          aria-pressed={isActive}
          className="min-w-0 flex-1 cursor-pointer rounded-lg px-0.5 py-0.5 text-left outline-none transition-colors hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          onClick={(event) => {
            event.stopPropagation();
            onUse();
          }}
          type="button"
        >
          <div className="flex items-center gap-1.5">
            <p className="truncate text-sm font-medium text-foreground">{theme.label}</p>
            {isPersonal ? (
              <span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium text-accent-foreground">
                Personal
              </span>
            ) : null}
          </div>
        </button>
        {onDownload || onRemove ? (
          <div className="flex shrink-0 items-center gap-1">
            {onDownload ? (
              <Button
                aria-label={`Export ${theme.label}`}
                size="icon-xs"
                variant="ghost"
                onClick={(event) => {
                  event.stopPropagation();
                  onDownload();
                }}
              >
                <DownloadIcon />
              </Button>
            ) : null}
            {onRemove ? (
              <Button
                aria-label={`Remove ${theme.label}`}
                size="icon-xs"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove();
                }}
              >
                <Trash2Icon />
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ThemeLibrary({
  theme,
  setTheme,
  followSystem,
  setFollowSystem,
  customThemes,
  initialAppearance,
}: {
  theme: string;
  setTheme: (theme: string) => void;
  followSystem: boolean;
  setFollowSystem: (followSystem: boolean) => void;
  customThemes: ReadonlyArray<ThemeDefinition>;
  initialAppearance: ThemeAppearance;
}) {
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const activeTheme = getThemeDefinition(theme);
  const standardThemes = getStandardThemeCards();
  const maintainerThemes = [T3_CHAT_THEME];

  const handleFollowSystemChange = useCallback(
    (checked: boolean) => {
      setFollowSystem(checked);
      setTheme(
        checked
          ? (activeTheme?.id ?? "system")
          : activeTheme
            ? themePreferenceForMode(activeTheme, initialAppearance)
            : initialAppearance,
      );
    },
    [activeTheme, initialAppearance, setFollowSystem, setTheme],
  );

  const handleRemoveTheme = useCallback(
    (customTheme: ThemeDefinition) => {
      if (!window.confirm(`Remove the “${customTheme.label}” theme?`)) return;
      removeCustomTheme(customTheme.id);
      if (getThemeDefinition(theme)?.id === customTheme.id) setTheme("system");
    },
    [setTheme, theme],
  );

  const handleCreatedTheme = useCallback(
    (createdTheme: ThemeDefinition) => {
      setTheme(createdTheme.id);
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: `${createdTheme.label} created`,
          description: "It’s now active.",
        }),
      );
    },
    [setTheme],
  );

  return (
    <div className="space-y-3 pt-2">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-3 px-3 sm:px-4">
        <h3 className="text-sm font-medium tracking-[-0.005em] text-foreground">Themes</h3>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <span>Follow system</span>
            <Switch
              aria-label="Follow system appearance"
              checked={followSystem}
              onCheckedChange={(checked) => handleFollowSystemChange(Boolean(checked))}
            />
          </label>
          <Button size="xs" variant="outline" onClick={() => setIsCreateOpen(true)}>
            <PlusIcon />
            Create theme
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setIsImportOpen(true)}>
            <UploadIcon />
            Import JSON
          </Button>
        </div>
      </div>
      <p className="px-3 text-[13px] leading-[1.45] text-muted-foreground/80 sm:px-4">
        Choose how T3 Code looks. Use a built-in theme or make your own.
      </p>
      <div className="grid gap-2 px-3 sm:grid-cols-2 sm:px-4">
        {standardThemes.map((standardTheme) => (
          <ThemeLibraryCard
            activeMode={
              theme === "system" || theme === "light" || theme === "dark"
                ? (getThemePreferenceMode(theme) ?? initialAppearance)
                : null
            }
            isActive={theme === "system" || theme === "light" || theme === "dark"}
            isPersonal={false}
            key={standardTheme.id}
            onUse={() => setTheme(followSystem ? "system" : initialAppearance)}
            onUseMode={followSystem ? undefined : setTheme}
            theme={standardTheme}
          />
        ))}
        {maintainerThemes.map((maintainerTheme) => {
          const isActive = getThemeDefinition(theme)?.id === maintainerTheme.id;
          const mode = isActive
            ? followSystem
              ? initialAppearance
              : (getThemePreferenceMode(theme) ?? maintainerTheme.appearance)
            : maintainerTheme.appearance;
          return (
            <ThemeLibraryCard
              activeMode={isActive ? mode : null}
              isActive={isActive}
              isPersonal={false}
              key={maintainerTheme.id}
              onUse={() => setTheme(maintainerTheme.id)}
              onUseMode={
                followSystem
                  ? undefined
                  : (nextMode: ThemeAppearance) =>
                      setTheme(themePreferenceForMode(maintainerTheme.id, nextMode))
              }
              theme={getThemeCardDefinition(maintainerTheme)}
            />
          );
        })}
        {customThemes.map((customTheme) => {
          const isActive = getThemeDefinition(theme)?.id === customTheme.id;
          const mode = isActive
            ? followSystem
              ? initialAppearance
              : (getThemePreferenceMode(theme) ?? customTheme.appearance)
            : customTheme.appearance;
          return (
            <ThemeLibraryCard
              activeMode={isActive ? mode : null}
              isActive={isActive}
              isPersonal
              key={customTheme.id}
              onDownload={() =>
                downloadThemeFile(`${customTheme.id}.json`, serializeThemeFile(customTheme))
              }
              onRemove={() => handleRemoveTheme(customTheme)}
              onUse={() => setTheme(customTheme.id)}
              onUseMode={
                followSystem
                  ? undefined
                  : (nextMode: ThemeAppearance) =>
                      setTheme(themePreferenceForMode(customTheme.id, nextMode))
              }
              theme={getThemeCardDefinition(customTheme)}
            />
          );
        })}
      </div>
      {customThemes.length === 0 ? (
        <div className="mx-3 rounded-xl border border-dashed border-border/80 bg-muted/20 px-4 py-3 text-xs text-muted-foreground sm:mx-4">
          Your themes will show up here.
        </div>
      ) : null}
      <CreateThemeDialog
        initialAppearance={initialAppearance}
        onCreated={handleCreatedTheme}
        onOpenChange={setIsCreateOpen}
        open={isCreateOpen}
      />
      <ThemeImportDialog
        onImported={(importedTheme) => {
          setTheme(importedTheme.id);
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: `${importedTheme.label} added`,
              description: "It’s now active.",
            }),
          );
        }}
        onOpenChange={setIsImportOpen}
        open={isImportOpen}
      />
    </div>
  );
}

export function AppearanceSettingsPanel() {
  const { theme, setTheme, setFollowSystem, followSystem, resolvedTheme } = useTheme();
  const customThemes = useCustomThemes();
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const environmentStageLabel = useEnvironmentStageLabel();
  const showEnvironmentIdentification =
    resolveEnvironmentIdentificationPillLabel(environmentStageLabel) !== null;
  const glassOpacityRatio =
    (settings.glassOpacity - MIN_GLASS_OPACITY) / (MAX_GLASS_OPACITY - MIN_GLASS_OPACITY);
  const glassOpacitySliderStyle = {
    "--glass-slider-progress": `${glassOpacityRatio * 100}%`,
    "--glass-slider-fill-offset": `${0.5 - glassOpacityRatio}rem`,
  } as CSSProperties;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Appearance">
        <ThemeLibrary
          customThemes={customThemes}
          followSystem={followSystem}
          initialAppearance={resolvedTheme}
          setFollowSystem={setFollowSystem}
          setTheme={setTheme}
          theme={theme}
        />

        <SettingsRow
          {...searchableSetting("setting-glass-opacity")}
          description="Control how transparent glass surfaces are. Higher values make menus, dialogs, and the composer more solid."
          resetAction={
            settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity ? (
              <SettingResetButton
                label="glass opacity"
                onClick={() =>
                  updateSettings({ glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="glass-opacity"
              >
                {settings.glassOpacity}%
              </output>
              <input
                aria-label="Glass opacity"
                className="glass-opacity-slider min-w-0 flex-1"
                id="glass-opacity"
                max={MAX_GLASS_OPACITY}
                min={MIN_GLASS_OPACITY}
                onChange={(event) => {
                  const glassOpacity = Number(event.currentTarget.value);
                  if (
                    Number.isInteger(glassOpacity) &&
                    glassOpacity >= MIN_GLASS_OPACITY &&
                    glassOpacity <= MAX_GLASS_OPACITY
                  ) {
                    updateSettings({ glassOpacity });
                  }
                }}
                step={5}
                style={glassOpacitySliderStyle}
                type="range"
                value={settings.glassOpacity}
              />
            </div>
          }
        />

        {showEnvironmentIdentification ? (
          <SettingsRow
            {...searchableSetting("environment-identification")}
            description="Choose how Dev and Nightly environments are identified."
            resetAction={
              settings.environmentIdentificationMode !== DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE ? (
                <SettingResetButton
                  label="environment identification"
                  onClick={() =>
                    updateSettings({
                      environmentIdentificationMode: DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.environmentIdentificationMode}
                onValueChange={(value) => {
                  if (value === "artwork" || value === "pill" || value === "none") {
                    updateSettings({ environmentIdentificationMode: value });
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-40" aria-label="Environment identification">
                  <SelectValue>
                    {ENVIRONMENT_IDENTIFICATION_LABELS[settings.environmentIdentificationMode]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {Object.entries(ENVIRONMENT_IDENTIFICATION_LABELS).map(([value, label]) => (
                    <SelectItem hideIndicator key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        ) : null}

        <SettingsRow
          {...searchableSetting("word-wrap")}
          description="Wrap long lines in code blocks, tables, diffs, and file previews by default."
          resetAction={
            settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? (
              <SettingResetButton
                label="word wrapping"
                onClick={() =>
                  updateSettings({
                    wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.wordWrap}
              onCheckedChange={(checked) => updateSettings({ wordWrap: Boolean(checked) })}
              aria-label="Wrap code, tables, diffs, and file previews by default"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function GeneralSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const [backgroundActivityDialogOpen, setBackgroundActivityDialogOpen] = useState(false);
  const lastEnabledProjectGroupingMode = useRef<SidebarProjectGroupingMode>(
    readLastEnabledProjectGroupingMode(),
  );
  const observability = useAtomValue(primaryServerObservabilityAtom);
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const diagnosticsDescription = formatDiagnosticsDescription({
    localTracingEnabled: observability?.localTracingEnabled ?? false,
    otlpTracesEnabled: observability?.otlpTracesEnabled ?? false,
    otlpTracesUrl: observability?.otlpTracesUrl,
    otlpMetricsEnabled: observability?.otlpMetricsEnabled ?? false,
    otlpMetricsUrl: observability?.otlpMetricsUrl,
  });

  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const textGenerationModelInstanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
  );
  const textGenInstanceEntry = textGenerationModelInstanceEntries.find(
    (entry) => entry.instanceId === textGenInstanceId,
  );
  const textGenProvider: ProviderDriverKind =
    textGenInstanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;
  const textGenerationModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    textGenInstanceId,
    textGenModel,
  );
  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const activeBackgroundActivityProfile = resolvedBackgroundActivity.profile;
  const backgroundActivityProfileOption = resolveBackgroundActivityProfileOption(settings);
  const backgroundActivityDescription =
    backgroundActivityProfileOption === "advanced"
      ? `${ADVANCED_BACKGROUND_ACTIVITY_DESCRIPTION} Current shared policy: ${
          BACKGROUND_ACTIVITY_PROFILE_LABELS[activeBackgroundActivityProfile]
        }.`
      : BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS[resolvedBackgroundActivity.profile];
  const canResetBackgroundActivity = !Equal.equals(
    settings.backgroundActivity,
    DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  );

  return (
    <SettingsPageContainer>
      <SettingsSection title="General">
        <SettingsRow
          {...searchableSetting("project-grouping")}
          description="Combine matching repositories across environments."
          resetAction={
            settings.sidebarProjectGroupingMode !==
            DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode ? (
              <SettingResetButton
                label="project grouping"
                onClick={() =>
                  updateSettings({
                    sidebarProjectGroupingMode: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={isProjectGroupingEnabled(settings.sidebarProjectGroupingMode)}
              onCheckedChange={(checked) => {
                if (!checked && settings.sidebarProjectGroupingMode !== "separate") {
                  lastEnabledProjectGroupingMode.current = settings.sidebarProjectGroupingMode;
                  rememberEnabledProjectGroupingMode(settings.sidebarProjectGroupingMode);
                }
                updateSettings({
                  sidebarProjectGroupingMode: projectGroupingModeFromToggle(
                    checked,
                    lastEnabledProjectGroupingMode.current,
                  ),
                });
              }}
              aria-label="Project grouping"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("time-format")}
          description="System default follows your browser or OS clock preference."
          resetAction={
            settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
              <SettingResetButton
                label="time format"
                onClick={() =>
                  updateSettings({
                    timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value === "locale" || value === "12-hour" || value === "24-hour") {
                  updateSettings({ timestampFormat: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Timestamp format">
                <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="locale">
                  {TIMESTAMP_FORMAT_LABELS.locale}
                </SelectItem>
                <SelectItem hideIndicator value="12-hour">
                  {TIMESTAMP_FORMAT_LABELS["12-hour"]}
                </SelectItem>
                <SelectItem hideIndicator value="24-hour">
                  {TIMESTAMP_FORMAT_LABELS["24-hour"]}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          {...searchableSetting("hide-whitespace-changes")}
          description="Set whether the diff panel ignores whitespace-only edits by default."
          resetAction={
            settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace ? (
              <SettingResetButton
                label="diff whitespace changes"
                onClick={() =>
                  updateSettings({
                    diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.diffIgnoreWhitespace}
              onCheckedChange={(checked) =>
                updateSettings({ diffIgnoreWhitespace: Boolean(checked) })
              }
              aria-label="Hide whitespace changes by default"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("assistant-output")}
          description="Show token-by-token output while a response is in progress."
          resetAction={
            settings.enableAssistantStreaming !==
            DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming ? (
              <SettingResetButton
                label="assistant output"
                onClick={() =>
                  updateSettings({
                    enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableAssistantStreaming}
              onCheckedChange={(checked) =>
                updateSettings({ enableAssistantStreaming: Boolean(checked) })
              }
              aria-label="Stream assistant messages"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("provider-update-checks")}
          description="Check installed provider CLIs for newer available versions."
          resetAction={
            settings.enableProviderUpdateChecks !==
            DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks ? (
              <SettingResetButton
                label="provider update checks"
                onClick={() =>
                  updateSettings({
                    enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableProviderUpdateChecks}
              onCheckedChange={(checked) =>
                updateSettings({ enableProviderUpdateChecks: Boolean(checked) })
              }
              aria-label="Check provider versions"
            />
          }
        />

        <SettingsRow
          title={
            <span className="inline-flex items-center gap-1.5">
              Background activity
              <PolicyTooltip>
                This shared policy gates background work such as Git refreshes and provider health
                probes after their individual intervals elapse.
              </PolicyTooltip>
            </span>
          }
          description={backgroundActivityDescription}
          resetAction={
            canResetBackgroundActivity ? (
              <SettingResetButton
                label="background activity"
                onClick={() => updateSettings(resetBackgroundActivitySettings())}
              />
            ) : null
          }
          control={
            <>
              <Select
                value={backgroundActivityProfileOption}
                onValueChange={(value) => {
                  if (value === "advanced") {
                    setBackgroundActivityDialogOpen(true);
                    return;
                  }
                  if (
                    value === "balanced" ||
                    value === "performance" ||
                    value === "battery-saver"
                  ) {
                    updateSettings(backgroundActivityProfileSettings(value));
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-40" aria-label="Background activity profile">
                  <SelectValue>
                    {BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS[backgroundActivityProfileOption]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="balanced">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS.balanced}
                  </SelectItem>
                  <SelectItem hideIndicator value="performance">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS.performance}
                  </SelectItem>
                  <SelectItem hideIndicator value="battery-saver">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS["battery-saver"]}
                  </SelectItem>
                  <SelectItem hideIndicator value="advanced">
                    {BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS.advanced}
                  </SelectItem>
                </SelectPopup>
              </Select>
              {backgroundActivityProfileOption === "advanced" ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="outline"
                        aria-label="Configure advanced background activity"
                        onClick={() => setBackgroundActivityDialogOpen(true)}
                      >
                        <SettingsIcon className="size-4" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">Configure background activity</TooltipPopup>
                </Tooltip>
              ) : null}
              <BackgroundActivityAdvancedDialog
                open={backgroundActivityDialogOpen}
                onOpenChange={setBackgroundActivityDialogOpen}
              />
            </>
          }
        />

        <SettingsRow
          {...searchableSetting("auto-open-task-panel")}
          description="Open the right-side plan and task panel automatically when steps appear."
          resetAction={
            settings.autoOpenPlanSidebar !== DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar ? (
              <SettingResetButton
                label="auto-open task panel"
                onClick={() =>
                  updateSettings({
                    autoOpenPlanSidebar: DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.autoOpenPlanSidebar}
              onCheckedChange={(checked) =>
                updateSettings({ autoOpenPlanSidebar: Boolean(checked) })
              }
              aria-label="Open the task panel automatically"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("new-threads")}
          description="Pick the default workspace mode for newly created draft threads."
          resetAction={
            settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode ||
            settings.newWorktreesStartFromOrigin !==
              DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin ? (
              <SettingResetButton
                label="new threads"
                onClick={() =>
                  updateSettings({
                    defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
                    newWorktreesStartFromOrigin:
                      DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.defaultThreadEnvMode}
              onValueChange={(value) => {
                if (value === "local" || value === "worktree") {
                  updateSettings({ defaultThreadEnvMode: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="Default thread mode">
                <SelectValue>
                  {settings.defaultThreadEnvMode === "worktree" ? "New worktree" : "Local"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="local">
                  Local
                </SelectItem>
                <SelectItem hideIndicator value="worktree">
                  New worktree
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        {settings.defaultThreadEnvMode === "worktree" ? (
          <SettingsRow
            className="bg-muted/20 sm:pl-9"
            title={searchableSetting("start-from-origin").title}
            description="Creates the worktree from the latest matching branch on origin instead of your local branch."
            resetAction={
              settings.newWorktreesStartFromOrigin !==
              DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin ? (
                <SettingResetButton
                  label="new worktrees start from origin"
                  onClick={() =>
                    updateSettings({
                      newWorktreesStartFromOrigin:
                        DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.newWorktreesStartFromOrigin}
                onCheckedChange={(checked) =>
                  updateSettings({ newWorktreesStartFromOrigin: Boolean(checked) })
                }
                aria-label="Start new worktrees from origin by default"
              />
            }
          />
        ) : null}

        <SettingsRow
          {...searchableSetting("add-project-starts-in")}
          description='Leave empty to use "~/" when the Add Project browser opens.'
          resetAction={
            settings.addProjectBaseDirectory !==
            DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
              <SettingResetButton
                label="add project base directory"
                onClick={() =>
                  updateSettings({
                    addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
                  })
                }
              />
            ) : null
          }
          control={
            <DraftInput
              className="w-full sm:w-72"
              value={settings.addProjectBaseDirectory}
              onCommit={(next) => updateSettings({ addProjectBaseDirectory: next })}
              placeholder="~/"
              spellCheck={false}
              aria-label="Add project base directory"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("archive-confirmation")}
          description="Require a second click on the inline archive action before a thread is archived."
          resetAction={
            settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
              <SettingResetButton
                label="archive confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadArchive}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadArchive: Boolean(checked) })
              }
              aria-label="Confirm thread archiving"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("delete-confirmation")}
          description="Ask before deleting a thread and its chat history."
          resetAction={
            settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
              <SettingResetButton
                label="delete confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadDelete}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadDelete: Boolean(checked) })
              }
              aria-label="Confirm thread deletion"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("text-generation-model")}
          description="Default model for generated text like thread titles and source control content. Source control settings can override it with a dedicated source control writer model."
          resetAction={
            isTextGenerationModelDirty ? (
              <SettingResetButton
                label="text generation model"
                onClick={() =>
                  updateSettings({
                    textGenerationModelSelection:
                      DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <ProviderModelPicker
                activeInstanceId={textGenInstanceId}
                model={textGenModel}
                lockedProvider={null}
                instanceEntries={textGenerationModelInstanceEntries}
                modelOptionsByInstance={textGenerationModelOptionsByInstance}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onInstanceModelChange={(instanceId, model) => {
                  updateSettings({
                    textGenerationModelSelection: resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: createModelSelection(instanceId, model),
                      },
                      serverProviders,
                    ),
                  });
                }}
              />
              <TraitsPicker
                provider={textGenProvider}
                models={
                  // Use the exact instance's models (rather than the
                  // first-kind-match) so a custom text-gen instance like
                  // `codex_personal` gets its own model list, not the
                  // default Codex one.
                  textGenInstanceEntry?.models ?? []
                }
                model={textGenModel}
                prompt=""
                onPromptChange={() => {}}
                modelOptions={textGenModelOptions}
                allowPromptInjectedEffort={false}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onModelOptionsChange={(nextOptions) => {
                  updateSettings({
                    textGenerationModelSelection: resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: createModelSelection(
                          textGenInstanceId,
                          textGenModel,
                          nextOptions,
                        ),
                      },
                      serverProviders,
                    ),
                  });
                }}
              />
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection title="About">
        {isElectron || HOSTED_APP_CHANNEL ? (
          <AboutVersionSection />
        ) : (
          <SettingsRow
            title={<AboutVersionTitle />}
            description="Current version of the application."
          />
        )}
        <SettingsRow
          {...searchableSetting("diagnostics")}
          description={diagnosticsDescription}
          control={
            <Button render={<Link to="/settings/diagnostics" />} size="xs" variant="outline">
              View diagnostics
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function ProviderSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const primaryEnvironment = usePrimaryEnvironment();
  const refreshServerProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const [isAddInstanceDialogOpen, setIsAddInstanceDialogOpen] = useState(false);
  const [updatingProviderDrivers, setUpdatingProviderDrivers] = useState<
    ReadonlySet<ProviderDriverKind>
  >(() => new Set());
  const [openInstanceDetails, setOpenInstanceDetails] = useState<Record<string, boolean>>({});
  const refreshingRef = useRef(false);

  const providerUpdateCandidates = useMemo(
    () => collectProviderUpdateCandidates(serverProviders),
    [serverProviders],
  );
  const providerUpdateCandidateByInstanceId = useMemo(
    () => new Map(providerUpdateCandidates.map((candidate) => [candidate.instanceId, candidate])),
    [providerUpdateCandidates],
  );
  const visibleProviderSettings = PROVIDER_SETTINGS.filter(
    (providerSettings) =>
      providerSettings.provider !== "cursor" ||
      serverProviders.some(
        (provider) =>
          provider.instanceId === defaultInstanceIdForDriver(ProviderDriverKind.make("cursor")),
      ),
  );
  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const providerHealthPreset = getBackgroundActivityPresetSettings(
    resolvedBackgroundActivity.profile,
  ).providerHealthRefreshInterval;
  const providerHealthRefreshIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.providerHealthRefreshInterval,
  );
  const defaultProviderHealthRefreshIntervalSeconds = durationToSeconds(providerHealthPreset);
  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null;

  const refreshProviders = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    if (!primaryEnvironment) {
      refreshingRef.current = false;
      setIsRefreshingProviders(false);
      return;
    }
    void (async () => {
      const result = await refreshServerProviders({
        environmentId: primaryEnvironment.environmentId,
        input: {},
      });
      refreshingRef.current = false;
      setIsRefreshingProviders(false);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        console.warn("Failed to refresh providers", {
          operation: "refresh-providers",
          environmentId: primaryEnvironment.environmentId,
          ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
        });
      }
    })();
  }, [primaryEnvironment, refreshServerProviders]);

  const runProviderUpdate = useCallback(
    async (candidate: ProviderUpdateCandidate) => {
      if (!primaryEnvironment) return;
      let started = false;
      setUpdatingProviderDrivers((previous) => {
        if (previous.has(candidate.driver)) {
          return previous;
        }
        started = true;
        const next = new Set(previous);
        next.add(candidate.driver);
        return next;
      });
      if (!started) {
        return;
      }

      const result = await updateProvider({
        environmentId: primaryEnvironment.environmentId,
        input: {
          provider: candidate.driver,
          instanceId: candidate.instanceId,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not update ${PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver}`,
            description:
              error instanceof Error
                ? error.message
                : "The provider update command could not be started.",
          }),
        );
      }
      setUpdatingProviderDrivers((previous) => {
        if (!previous.has(candidate.driver)) {
          return previous;
        }
        const next = new Set(previous);
        next.delete(candidate.driver);
        return next;
      });
    },
    [primaryEnvironment, updateProvider],
  );

  interface InstanceRow {
    readonly instanceId: ProviderInstanceId;
    readonly instance: ProviderInstanceConfig;
    readonly driver: ProviderDriverKind;
    readonly isDefault: boolean;
    readonly isDirty?: boolean;
  }

  const instancesByDriver = new Map<
    ProviderDriverKind,
    Array<[ProviderInstanceId, ProviderInstanceConfig]>
  >();
  for (const [rawId, instance] of Object.entries(settings.providerInstances ?? {})) {
    const driver = instance.driver;
    const list = instancesByDriver.get(driver) ?? [];
    list.push([rawId as ProviderInstanceId, instance]);
    instancesByDriver.set(driver, list);
  }

  const defaultSlotIdsBySource = new Set<string>(
    visibleProviderSettings.map((providerSettings) =>
      String(defaultInstanceIdForDriver(providerSettings.provider)),
    ),
  );

  const rows: InstanceRow[] = [];
  const visibleDriverKinds = new Set<ProviderDriverKind>(
    visibleProviderSettings.map((providerSettings) => providerSettings.provider),
  );

  for (const providerSettings of visibleProviderSettings) {
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
    const legacyProviders = settings.providers as Record<string, LegacyProviderSettings>;
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings
    >;
    const driver = providerSettings.provider;
    const defaultInstanceId = defaultInstanceIdForDriver(driver);
    const explicitInstance = settings.providerInstances?.[defaultInstanceId];
    const legacyConfig = legacyProviders[providerSettings.provider]!;
    const defaultLegacyConfig = defaultLegacyProviders[providerSettings.provider]!;
    const effectiveInstance: ProviderInstanceConfig =
      explicitInstance ??
      ({
        driver,
        enabled: legacyConfig.enabled,
        config: legacyConfig,
      } satisfies ProviderInstanceConfig);
    const isDirty =
      explicitInstance !== undefined || !Equal.equals(legacyConfig, defaultLegacyConfig);
    rows.push({
      instanceId: defaultInstanceId,
      instance: effectiveInstance,
      driver,
      isDefault: true,
      isDirty,
    });
    for (const [id, instance] of instancesByDriver.get(providerSettings.provider) ?? []) {
      if (id === defaultInstanceId) continue;
      rows.push({ instanceId: id, instance, driver: instance.driver, isDefault: false });
    }
  }
  for (const [driver, list] of instancesByDriver) {
    if (visibleDriverKinds.has(driver)) continue;
    for (const [id, instance] of list) {
      rows.push({
        instanceId: id,
        instance,
        driver: instance.driver,
        isDefault: defaultSlotIdsBySource.has(String(id)),
      });
    }
  }

  const updateProviderInstance = (
    row: InstanceRow,
    next: ProviderInstanceConfig,
    options?: {
      readonly textGenerationModelSelection?: Parameters<
        typeof buildProviderInstanceUpdatePatch
      >[0]["textGenerationModelSelection"];
    },
  ) => {
    updateSettings(
      buildProviderInstanceUpdatePatch({
        settings,
        instanceId: row.instanceId,
        instance: next,
        driver: row.driver,
        isDefault: row.isDefault,
        textGenerationModelSelection: options?.textGenerationModelSelection,
      }),
    );
  };

  const deleteProviderInstance = (id: ProviderInstanceId) => {
    updateSettings({
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, id),
      providerModelPreferences: withoutProviderInstanceKey(settings.providerModelPreferences, id),
      favorites: withoutProviderInstanceFavorites(settings.favorites ?? [], id),
    });
  };

  const updateProviderModelPreferences = (
    instanceId: ProviderInstanceId,
    next: {
      readonly hiddenModels: ReadonlyArray<string>;
      readonly modelOrder: ReadonlyArray<string>;
    },
  ) => {
    const hiddenModels = [...new Set(next.hiddenModels.filter((slug) => slug.trim().length > 0))];
    const modelOrder = [...new Set(next.modelOrder.filter((slug) => slug.trim().length > 0))];
    const rest = withoutProviderInstanceKey(settings.providerModelPreferences, instanceId);
    updateSettings({
      providerModelPreferences:
        hiddenModels.length === 0 && modelOrder.length === 0
          ? rest
          : {
              ...rest,
              [instanceId]: {
                hiddenModels,
                modelOrder,
              },
            },
    });
  };

  const updateProviderFavoriteModels = (
    instanceId: ProviderInstanceId,
    nextFavoriteModels: ReadonlyArray<string>,
  ) => {
    const favoriteModels = [
      ...new Set(
        Arr.filterMap(nextFavoriteModels, (slug) => {
          const trimmedSlug = slug.trim();
          return trimmedSlug.length > 0 ? Result.succeed(trimmedSlug) : Result.failVoid;
        }),
      ),
    ];
    updateSettings({
      favorites: [
        ...withoutProviderInstanceFavorites(settings.favorites ?? [], instanceId),
        ...favoriteModels.map((model) => ({ provider: instanceId, model })),
      ],
    });
  };

  const resetDefaultInstance = (driverKind: ProviderDriverKind) => {
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings | undefined
    >;
    const defaultInstanceId = defaultInstanceIdForDriver(driverKind);
    const defaultLegacyProvider = defaultLegacyProviders[driverKind];
    if (defaultLegacyProvider === undefined) return;
    updateSettings({
      providers: {
        ...settings.providers,
        [driverKind]: defaultLegacyProvider,
      } as typeof settings.providers,
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, defaultInstanceId),
      providerModelPreferences: withoutProviderInstanceKey(
        settings.providerModelPreferences,
        defaultInstanceId,
      ),
      favorites: withoutProviderInstanceFavorites(settings.favorites ?? [], defaultInstanceId),
    });
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("providers")}
        headerAction={
          <div className="flex items-center gap-1.5">
            <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    onClick={() => setIsAddInstanceDialogOpen(true)}
                    aria-label="Add provider instance"
                  >
                    <PlusIcon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">Add provider instance</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    disabled={isRefreshingProviders}
                    onClick={() => void refreshProviders()}
                    aria-label="Refresh provider status"
                  >
                    {isRefreshingProviders ? (
                      <LoaderIcon className="size-3 animate-spin" />
                    ) : (
                      <RefreshCwIcon className="size-3" />
                    )}
                  </Button>
                }
              />
              <TooltipPopup side="top">Refresh provider status</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-1.5">
              Health check interval
              <PolicyTooltip>
                This interval is configured here, then the shared Background activity policy decides
                whether provider probes may run when the timer fires. Custom intervals appear as
                Advanced in General settings.
              </PolicyTooltip>
            </span>
          }
          description="Refresh provider availability, versions, auth state, and model metadata in the background. Set this to 0 seconds to rely on manual refreshes."
          resetAction={
            providerHealthRefreshIntervalSeconds !== defaultProviderHealthRefreshIntervalSeconds ? (
              <SettingResetButton
                label="provider health check interval"
                onClick={() =>
                  updateSettings(
                    backgroundActivityOverrideSettings(
                      settings.backgroundActivity,
                      resolvedBackgroundActivity,
                      {
                        providerHealthRefreshInterval: undefined,
                      },
                    ),
                  )
                }
              />
            ) : null
          }
          control={
            <div className="flex shrink-0 items-center gap-2">
              <NumberField
                value={providerHealthRefreshIntervalSeconds}
                min={0}
                step={PROVIDER_HEALTH_INTERVAL_STEP_SECONDS}
                size="sm"
                className="w-32"
                onValueChange={(value) =>
                  updateSettings(
                    backgroundActivityOverrideSettings(
                      settings.backgroundActivity,
                      resolvedBackgroundActivity,
                      {
                        providerHealthRefreshInterval: Duration.seconds(
                          normalizeIntervalSeconds(value),
                        ),
                      },
                    ),
                  )
                }
              >
                <NumberFieldGroup>
                  <NumberFieldDecrement aria-label="Decrease provider health check interval" />
                  <NumberFieldInput aria-label="Provider health check interval in seconds" />
                  <NumberFieldIncrement aria-label="Increase provider health check interval" />
                </NumberFieldGroup>
              </NumberField>
              <span className="text-xs text-muted-foreground">seconds</span>
            </div>
          }
        />

        {rows.map((row) => {
          const driverOption = getDriverOption(row.driver);
          const liveProvider = serverProviders.find(
            (candidate) => candidate.instanceId === row.instanceId,
          );
          const updateCandidate = liveProvider
            ? providerUpdateCandidateByInstanceId.get(liveProvider.instanceId)
            : undefined;
          const isDriverUpdateRunning =
            updateCandidate !== undefined &&
            (updatingProviderDrivers.has(updateCandidate.driver) ||
              serverProviders.some(
                (provider) =>
                  provider.driver === updateCandidate.driver && isProviderUpdateActive(provider),
              ));
          const showInlineUpdateButton =
            updateCandidate !== undefined &&
            hasOneClickUpdateProviderCandidate(updateCandidate, serverProviders);
          const canRunInlineUpdate =
            updateCandidate !== undefined &&
            canOneClickUpdateProviderCandidate(updateCandidate, serverProviders) &&
            !updatingProviderDrivers.has(updateCandidate.driver);
          const modelPreferences = settings.providerModelPreferences?.[row.instanceId] ?? {
            hiddenModels: [],
            modelOrder: [],
          };
          const favoriteModels = Arr.filterMap(settings.favorites ?? [], (favorite) =>
            favorite.provider === row.instanceId ? Result.succeed(favorite.model) : Result.failVoid,
          );
          const resetLabel = driverOption?.label ?? String(row.driver);
          const headerAction =
            row.isDefault && row.isDirty ? (
              <SettingResetButton
                label={`${resetLabel} provider settings`}
                onClick={() => resetDefaultInstance(row.driver)}
              />
            ) : null;
          return (
            <ProviderInstanceCard
              key={row.instanceId}
              instanceId={row.instanceId}
              instance={row.instance}
              driverOption={driverOption}
              liveProvider={liveProvider}
              isExpanded={openInstanceDetails[row.instanceId] ?? false}
              onExpandedChange={(open) =>
                setOpenInstanceDetails((existing) => ({
                  ...existing,
                  [row.instanceId]: open,
                }))
              }
              onUpdate={(next) => {
                const wasEnabled = row.instance.enabled ?? true;
                const isDisabling = next.enabled === false && wasEnabled;
                const shouldClearTextGen = isDisabling && textGenInstanceId === row.instanceId;
                if (shouldClearTextGen) {
                  updateProviderInstance(row, next, {
                    textGenerationModelSelection:
                      DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                  });
                } else {
                  updateProviderInstance(row, next);
                }
              }}
              onDelete={row.isDefault ? undefined : () => deleteProviderInstance(row.instanceId)}
              headerAction={headerAction}
              hiddenModels={modelPreferences.hiddenModels}
              favoriteModels={favoriteModels}
              modelOrder={modelPreferences.modelOrder}
              onHiddenModelsChange={(hiddenModels) =>
                updateProviderModelPreferences(row.instanceId, {
                  ...modelPreferences,
                  hiddenModels,
                })
              }
              onFavoriteModelsChange={(favoriteModels) =>
                updateProviderFavoriteModels(row.instanceId, favoriteModels)
              }
              onModelOrderChange={(modelOrder) =>
                updateProviderModelPreferences(row.instanceId, {
                  ...modelPreferences,
                  modelOrder,
                })
              }
              onRunUpdate={
                showInlineUpdateButton && updateCandidate
                  ? () => {
                      if (!canRunInlineUpdate) {
                        return;
                      }
                      void runProviderUpdate(updateCandidate);
                    }
                  : undefined
              }
              isUpdating={showInlineUpdateButton ? isDriverUpdateRunning : undefined}
            />
          );
        })}
      </SettingsSection>

      {isAddInstanceDialogOpen ? (
        <AddProviderInstanceDialog open onOpenChange={setIsAddInstanceDialogOpen} />
      ) : null}
    </SettingsPageContainer>
  );
}

export function ArchivedThreadsPanel() {
  const projects = useProjects();
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const environmentIds = useMemo(
    () => [...new Set(projects.map((project) => project.environmentId))],
    [projects],
  );
  const {
    snapshots: archivedSnapshots,
    error: archiveError,
    isLoading: isLoadingArchive,
    refresh: refreshArchivedThreads,
  } = useArchivedThreadSnapshots(environmentIds);

  const archivedGroups = useMemo(() => {
    const projectsByEnvironmentAndId = new Map(
      archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
        snapshot.projects.map(
          (project) =>
            [
              `${environmentId}:${project.id}`,
              {
                id: project.id,
                environmentId,
                name: project.title,
                cwd: project.workspaceRoot,
              },
            ] as const,
        ),
      ),
    );
    const threads = archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
      snapshot.threads.map((thread) => ({
        ...thread,
        environmentId,
      })),
    );

    const archivedProjects = Array.from(projectsByEnvironmentAndId.values());
    const groups: Array<{
      readonly project: (typeof archivedProjects)[number];
      readonly threads: Array<(typeof threads)[number]>;
    }> = [];
    for (const project of archivedProjects) {
      const projectThreads: Array<(typeof threads)[number]> = [];
      for (const thread of threads) {
        if (thread.projectId === project.id && thread.environmentId === project.environmentId) {
          projectThreads.push(thread);
        }
      }
      if (projectThreads.length > 0) {
        groups.push({
          project,
          threads: projectThreads.toSorted((left, right) => {
            const leftKey = left.archivedAt ?? left.createdAt;
            const rightKey = right.archivedAt ?? right.createdAt;
            return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
          }),
        });
      }
    }
    return groups;
  }, [archivedSnapshots]);

  const handleArchivedThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "unarchive", label: "Unarchive" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "unarchive") {
        const result = await unarchiveThread(threadRef);
        if (result._tag === "Success") {
          refreshArchivedThreads();
        } else if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to unarchive thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      if (clicked === "delete") {
        const result = await confirmAndDeleteThread(threadRef);
        if (result._tag === "Success") {
          refreshArchivedThreads();
        } else if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to delete thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      }
    },
    [confirmAndDeleteThread, refreshArchivedThreads, unarchiveThread],
  );

  return (
    <SettingsPageContainer>
      {archivedGroups.length === 0 ? (
        <SettingsSection
          id={isLoadingArchive ? undefined : searchableSetting("archive").id}
          title={searchableSetting("archive").title}
        >
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                {isLoadingArchive ? (
                  <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
                ) : (
                  <ArchiveIcon className="size-3.5 text-muted-foreground" />
                )}
                {isLoadingArchive
                  ? "Loading archived threads"
                  : archiveError
                    ? "Could not load archived threads"
                    : "No archived threads"}
              </span>
            }
            description={
              isLoadingArchive
                ? "Checking connected environments."
                : (archiveError ?? "Archived threads will appear here.")
            }
          />
        </SettingsSection>
      ) : (
        archivedGroups.map(({ project, threads: projectThreads }, index) => (
          <SettingsSection
            key={project.id}
            id={index === 0 ? searchableSetting("archive").id : undefined}
            title={project.name}
            icon={<ProjectFavicon environmentId={project.environmentId} cwd={project.cwd} />}
          >
            {projectThreads.map((thread) => (
              <SettingsRow
                key={thread.id}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void (async () => {
                    const result = await settlePromise(() =>
                      handleArchivedThreadContextMenu(
                        scopeThreadRef(thread.environmentId, thread.id),
                        {
                          x: event.clientX,
                          y: event.clientY,
                        },
                      ),
                    );
                    if (result._tag === "Failure") {
                      const error = squashAtomCommandFailure(result);
                      toastManager.add(
                        stackedThreadToast({
                          type: "error",
                          title: "Archived thread action failed",
                          description:
                            error instanceof Error ? error.message : "An error occurred.",
                        }),
                      );
                    }
                  })();
                }}
                title={thread.title}
                description={
                  <>
                    Archived {formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt)}
                    {" \u00b7 Created "}
                    {formatRelativeTimeLabel(thread.createdAt)}
                  </>
                }
                control={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5"
                    onClick={() => {
                      void (async () => {
                        const result = await unarchiveThread(
                          scopeThreadRef(thread.environmentId, thread.id),
                        );
                        if (result._tag === "Success") {
                          refreshArchivedThreads();
                          return;
                        }
                        if (!isAtomCommandInterrupted(result)) {
                          const error = squashAtomCommandFailure(result);
                          toastManager.add(
                            stackedThreadToast({
                              type: "error",
                              title: "Failed to unarchive thread",
                              description:
                                error instanceof Error ? error.message : "An error occurred.",
                            }),
                          );
                        }
                      })();
                    }}
                  >
                    <ArchiveX className="size-3.5" />
                    <span>Unarchive</span>
                  </Button>
                }
              />
            ))}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}
