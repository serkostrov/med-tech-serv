import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";
import { cn } from "../../lib/utils.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.js";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    className={cn("fixed inset-0 z-50 bg-foreground/40", className)}
    ref={ref}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    readonly hideClose?: boolean;
  }
>(({ className, children, hideClose = false, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      className={cn(
        "fixed left-1/2 top-1/2 z-50 flex max-h-[min(90dvh,44rem)] w-[min(100%-1.5rem,40rem)] translate-x-[-50%] translate-y-[-50%] flex-col overflow-hidden focus:outline-none",
        className
      )}
      ref={ref}
      {...props}
    >
      {children}
      {hideClose ? null : (
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogPrimitive.Close
              aria-label="Закрыть"
              className="absolute right-2.5 top-2.5 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X aria-hidden="true" size={16} />
            </DialogPrimitive.Close>
          </TooltipTrigger>
          <TooltipContent>Закрыть</TooltipContent>
        </Tooltip>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("dialog-header", className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("dialog-footer", className)} {...props} />;
}

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title className={cn("text-lg font-semibold leading-6 tracking-tight", className)} ref={ref} {...props} />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description className={cn("text-[13px] leading-5 text-muted-foreground", className)} ref={ref} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger
};
