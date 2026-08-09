import type { DesktopNotificationEvent, DesktopNotificationSettings } from "@t3tools/contracts";
import {
  CheckIcon,
  CircleCheckBigIcon,
  CircleXIcon,
  MessageCircleQuestionIcon,
  ShieldAlertIcon,
  TagIcon,
  Volume2Icon,
  type LucideIcon,
} from "lucide-react";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings.ts";
import { cn } from "../../lib/utils.ts";
import { Button } from "../ui/button.tsx";
import { Switch } from "../ui/switch.tsx";
import { toastManager } from "../ui/toast.tsx";
import { SettingsRow, SettingsSection } from "./settingsLayout.tsx";
import { searchableSetting } from "./settingsSearch.ts";

const EVENT_OPTIONS: ReadonlyArray<{
  readonly event: DesktopNotificationEvent;
  readonly title: string;
  readonly description: string;
  readonly icon: LucideIcon;
}> = [
  {
    event: "approval",
    title: "Approval needed",
    description: "An agent is blocked until you approve an action.",
    icon: ShieldAlertIcon,
  },
  {
    event: "input",
    title: "Waiting for input",
    description: "An agent asks a question or needs more direction.",
    icon: MessageCircleQuestionIcon,
  },
  {
    event: "completion",
    title: "Agent finished",
    description: "A turn completes while you are working elsewhere.",
    icon: CircleCheckBigIcon,
  },
  {
    event: "failure",
    title: "Agent failed",
    description: "A provider or agent turn ends with an error.",
    icon: CircleXIcon,
  },
];

function OptionCard({
  title,
  description,
  icon: Icon,
  selected,
  onToggle,
}: {
  readonly title: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly selected: boolean;
  readonly onToggle: (selected: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onToggle(!selected)}
      className={cn(
        "group flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-left outline-none transition-[border-color,background-color,transform] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background active:scale-[0.98]",
        selected
          ? "border-primary bg-muted/40"
          : "border-border/60 bg-muted/15 hover:border-border",
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0 transition-colors duration-150",
          selected ? "text-primary" : "text-muted-foreground",
        )}
      />
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium tracking-[-0.005em] text-foreground">{title}</span>
          <CheckIcon
            className={cn(
              "size-3.5 shrink-0 text-primary transition-opacity duration-150",
              selected ? "opacity-100" : "opacity-0",
            )}
          />
        </span>
        <span className="block text-[13px] leading-[1.45] text-muted-foreground/80">
          {description}
        </span>
      </span>
    </button>
  );
}

export function DesktopNotificationsSettings() {
  const settings = useClientSettings((current) => current.desktopNotifications);
  const updateClientSettings = useUpdateClientSettings();
  const update = (patch: Partial<DesktopNotificationSettings>) => {
    updateClientSettings({ desktopNotifications: { ...settings, ...patch } });
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

  return (
    <SettingsSection
      {...searchableSetting("desktop-notifications")}
      title="Desktop notifications"
      headerAction={
        <Button size="xs" variant="outline" onClick={() => void sendTest()}>
          Send test
        </Button>
      }
    >
      <SettingsRow
        title="Enable notifications"
        description="Uses native macOS, Windows, or Linux notifications. Only shown while the desktop window is not focused."
        control={
          <Switch
            checked={settings.enabled}
            onCheckedChange={(checked) => update({ enabled: Boolean(checked) })}
            aria-label="Desktop notifications"
          />
        }
      />
      <div
        inert={!settings.enabled}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
          settings.enabled ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden">
          <div className="space-y-2 px-3 pt-1 pb-2 sm:px-4">
            <div className="grid gap-2 sm:grid-cols-2">
              {EVENT_OPTIONS.map((option) => (
                <OptionCard
                  key={option.event}
                  title={option.title}
                  description={option.description}
                  icon={option.icon}
                  selected={settings.events[option.event]}
                  onToggle={(selected) =>
                    update({ events: { ...settings.events, [option.event]: selected } })
                  }
                />
              ))}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <OptionCard
                title="Play sound"
                description="Plays the system notification sound."
                icon={Volume2Icon}
                selected={settings.soundEnabled}
                onToggle={(selected) => update({ soundEnabled: selected })}
              />
              <OptionCard
                title="Show names"
                description="Includes project and thread names in the text."
                icon={TagIcon}
                selected={settings.showContext}
                onToggle={(selected) => update({ showContext: selected })}
              />
            </div>
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}
