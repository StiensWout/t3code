import { memo, useCallback, useRef } from "react";
import { CopyIcon, CheckIcon } from "lucide-react";
import { Button } from "../ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { anchoredToastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type MessageClipboardImage, writeMessageToClipboard } from "../../messageClipboard";

const ANCHORED_TOAST_TIMEOUT_MS = 1000;
const onCopy = (ref: React.RefObject<HTMLButtonElement | null>) => {
  if (ref.current) {
    anchoredToastManager.add({
      data: {
        tooltipStyle: true,
      },
      positionerProps: {
        anchor: ref.current,
      },
      timeout: ANCHORED_TOAST_TIMEOUT_MS,
      title: "Copied!",
    });
  }
};

const onCopyError = (ref: React.RefObject<HTMLButtonElement | null>, error: Error) => {
  if (ref.current) {
    anchoredToastManager.add({
      data: {
        tooltipStyle: true,
      },
      positionerProps: {
        anchor: ref.current,
      },
      timeout: ANCHORED_TOAST_TIMEOUT_MS,
      title: "Failed to copy",
      description: error.message,
    });
  }
};

export const MessageCopyButton = memo(function MessageCopyButton({
  text,
  size = "xs",
  variant = "outline",
  className,
  image,
}: {
  text: string;
  size?: "xs" | "icon-xs";
  variant?: "outline" | "ghost";
  className?: string;
  image?: MessageClipboardImage;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const write = useCallback((value: string) => writeMessageToClipboard(value, image), [image]);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    ...(image ? { write } : {}),
    onCopy: () => onCopy(ref),
    onError: (error: Error) => onCopyError(ref, error),
    timeout: ANCHORED_TOAST_TIMEOUT_MS,
  });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Copy link"
            disabled={isCopied}
            onClick={() => copyToClipboard(text)}
            ref={ref}
            type="button"
            size={size}
            variant={variant}
            className={cn("text-muted-foreground hover:text-foreground", className)}
          />
        }
      >
        {isCopied ? <CheckIcon className="size-3 text-primary" /> : <CopyIcon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup>
        <p>Copy to clipboard</p>
      </TooltipPopup>
    </Tooltip>
  );
});
