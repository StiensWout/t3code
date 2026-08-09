import type { DesktopNotificationEvent, DesktopNotificationSettings } from "@t3tools/contracts";
import { EyeIcon, Volume2Icon } from "lucide-react";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings.ts";
import { Button } from "../ui/button.tsx";
import { Switch } from "../ui/switch.tsx";
import { toastManager } from "../ui/toast.tsx";
import { SettingsRow, SettingsSection } from "./settingsLayout.tsx";
import { searchableSetting } from "./settingsSearch.ts";

const EVENT_OPTIONS: ReadonlyArray<{
  readonly event: DesktopNotificationEvent;
  readonly title: string;
  readonly description: string;
}> = [
  {
    event: "approval",
    title: "Approval needed",
    description: "An agent is blocked until you approve an action.",
  },
  {
    event: "input",
    title: "Waiting for input",
    description: "An agent asks a question or needs more direction.",
  },
  {
    event: "completion",
    title: "Agent finished",
    description: "A turn completes while you are working elsewhere.",
  },
  {
    event: "failure",
    title: "Agent failed",
    description: "A provider or agent turn ends with an error.",
  },
];

function useDesktopNotificationSettingsModel() {
  const settings = useClientSettings((current) => current.desktopNotifications);
  const updateClientSettings = useUpdateClientSettings();
  const update = (patch: Partial<DesktopNotificationSettings>) => {
    updateClientSettings({ desktopNotifications: { ...settings, ...patch } });
  };
  const updateEvent = (event: DesktopNotificationEvent, enabled: boolean) => {
    update({ events: { ...settings.events, [event]: enabled } });
  };
  const sendTest = async () => {
    const notifications = window.desktopBridge?.notifications;
    if (!notifications) {
      toastManager.add({
        type: "warning",
        title: "Desktop app required",
        description: "Native notification tests are available in the desktop app.",
      });
      return;
    }
    const result = await notifications
      .showTest({ silent: !settings.soundEnabled })
      .catch(() => "failed" as const);
    if (result === "shown") {
      toastManager.add({
        type: "success",
        title: "Test sent",
        description: "Check your system notification center.",
      });
      return;
    }
    toastManager.add({
      type: "warning",
      title: "Notification unavailable",
      description:
        result === "unsupported"
          ? "Native notifications are not supported in this desktop session."
          : "The operating system could not display the notification.",
    });
  };

  return { settings, update, updateEvent, sendTest };
}

function MasterSwitch({
  settings,
  update,
}: Pick<ReturnType<typeof useDesktopNotificationSettingsModel>, "settings" | "update">) {
  return (
    <Switch
      checked={settings.enabled}
      onCheckedChange={(checked) => update({ enabled: Boolean(checked) })}
      aria-label="Desktop notifications"
    />
  );
}

function TestButton({
  settings,
  sendTest,
}: Pick<ReturnType<typeof useDesktopNotificationSettingsModel>, "settings" | "sendTest">) {
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={!settings.enabled}
      onClick={() => void sendTest()}
    >
      Send test
    </Button>
  );
}

function EventSwitch({
  event,
  settings,
  updateEvent,
}: Pick<ReturnType<typeof useDesktopNotificationSettingsModel>, "settings" | "updateEvent"> & {
  readonly event: DesktopNotificationEvent;
}) {
  return (
    <Switch
      checked={settings.events[event]}
      onCheckedChange={(checked) => updateEvent(event, Boolean(checked))}
      aria-label={EVENT_OPTIONS.find((option) => option.event === event)?.title}
    />
  );
}

function PreferenceControls({
  settings,
  update,
}: Pick<ReturnType<typeof useDesktopNotificationSettingsModel>, "settings" | "update">) {
  return (
    <div className="flex flex-wrap gap-2">
      <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border/70 bg-background/50 px-2.5 py-2 text-xs">
        <Volume2Icon className="size-3.5 text-muted-foreground" />
        Sound
        <Switch
          checked={settings.soundEnabled}
          onCheckedChange={(checked) => update({ soundEnabled: Boolean(checked) })}
          aria-label="Notification sound"
        />
      </label>
      <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border/70 bg-background/50 px-2.5 py-2 text-xs">
        <EyeIcon className="size-3.5 text-muted-foreground" />
        Show names
        <Switch
          checked={settings.showContext}
          onCheckedChange={(checked) => update({ showContext: Boolean(checked) })}
          aria-label="Show project and thread names"
        />
      </label>
    </div>
  );
}

function NotificationSectionHeader({
  model,
}: {
  readonly model: ReturnType<typeof useDesktopNotificationSettingsModel>;
}) {
  return <TestButton settings={model.settings} sendTest={model.sendTest} />;
}

export function DesktopNotificationsSettings() {
  const model = useDesktopNotificationSettingsModel();
  return (
    <SettingsSection
      {...searchableSetting("desktop-notifications")}
      title="Desktop notifications"
      headerAction={<NotificationSectionHeader model={model} />}
    >
      <SettingsRow
        title="Notify me outside the active thread"
        description="Uses native macOS, Windows, or Linux notifications. System placement and timing are respected."
        control={<MasterSwitch settings={model.settings} update={model.update} />}
      />
      <div className="rounded-xl border border-border/60 bg-muted/15 py-1">
        {EVENT_OPTIONS.map((option) => (
          <SettingsRow
            key={option.event}
            title={option.title}
            description={option.description}
            control={
              <EventSwitch
                event={option.event}
                settings={model.settings}
                updateEvent={model.updateEvent}
              />
            }
          />
        ))}
      </div>
      <SettingsRow
        title="Presentation"
        description="Every platform receives the same title and message text."
        control={<PreferenceControls settings={model.settings} update={model.update} />}
      />
    </SettingsSection>
  );
}
