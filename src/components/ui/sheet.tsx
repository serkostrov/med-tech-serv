import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";
import { cn } from "../../lib/utils.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.js";

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;
const SheetPortal = DialogPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    className={cn("fixed inset-0 z-50 bg-foreground/40", className)}
    ref={ref}
    {...props}
  />
));
SheetOverlay.displayName = DialogPrimitive.Overlay.displayName;

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    readonly side?: "left" | "right";
  }
>(({ className, children, side = "right", ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <DialogPrimitive.Content
      className={cn(
        "fixed z-50 flex h-full w-[min(100%,22rem)] flex-col focus:outline-none",
        side === "right" ? "inset-y-0 right-0" : "inset-y-0 left-0",
        className
      )}
      ref={ref}
      {...props}
    >
      {children}
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
    </DialogPrimitive.Content>
  </SheetPortal>
));
SheetContent.displayName = DialogPrimitive.Content.displayName;

function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("sheet-header", className)} {...props} />;
}

function SheetBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("sheet-body", className)} {...props} />;
}

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title className={cn("text-lg font-semibold leading-6", className)} ref={ref} {...props} />
));
SheetTitle.displayName = DialogPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description className={cn("text-sm leading-6 text-muted-foreground", className)} ref={ref} {...props} />
));
SheetDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger
};
