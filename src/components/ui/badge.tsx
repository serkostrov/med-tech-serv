import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "../../lib/utils.js";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold leading-5",
  {
    variants: {
      variant: {
        default: "border-transparent bg-secondary text-secondary-foreground",
        success: "border-transparent bg-[var(--color-success-soft)] text-[var(--color-success)]",
        warning: "border-transparent bg-[var(--color-warning-soft)] text-[var(--color-warning)]",
        danger: "border-transparent bg-[var(--color-danger-soft)] text-[var(--color-danger)]",
        info: "border-transparent bg-[var(--color-accent-soft)] text-[var(--color-accent-dark)]",
        purple: "border-transparent bg-[var(--color-purple-soft)] text-[var(--color-purple)]",
        outline: "border-border text-muted-foreground"
      }
    },
    defaultVariants: {
      variant: "default"
    }
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
