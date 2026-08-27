import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "../../lib/utils.js";

const alertVariants = cva(
  "relative flex w-full items-start gap-3 rounded-md border px-3.5 py-3 text-sm",
  {
    variants: {
      variant: {
        default: "border-border bg-card text-foreground",
        info: "border-[var(--color-accent)]/20 bg-[var(--color-accent-soft)] text-[var(--color-accent-dark)]",
        warning: "border-[var(--color-warning)]/25 bg-[var(--color-warning-soft)] text-[var(--color-warning)]",
        success: "border-[var(--color-success)]/25 bg-[var(--color-success-soft)] text-[var(--color-success)]",
        destructive: "border-[var(--color-danger)]/25 bg-[var(--color-danger-soft)] text-[var(--color-danger)]"
      }
    },
    defaultVariants: {
      variant: "default"
    }
  }
);

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, ...props }, ref) => (
  <div className={cn(alertVariants({ variant }), className)} ref={ref} role="status" {...props} />
));
Alert.displayName = "Alert";

function AlertTitle({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("font-semibold", className)} {...props} />;
}

function AlertDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm leading-6 text-current/90", className)} {...props} />;
}

export { Alert, AlertDescription, AlertTitle };
