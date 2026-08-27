import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "../../lib/utils.js";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        secondary: "border border-border bg-card text-foreground hover:bg-accent hover:text-accent-foreground",
        outline: "border border-border bg-transparent hover:bg-accent hover:text-accent-foreground",
        ghost: "text-primary hover:bg-accent hover:text-accent-foreground",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        success: "bg-[var(--color-success)] text-white hover:bg-[#12683d]",
        link: "text-primary underline-offset-4 hover:underline"
      },
      size: {
        default: "h-8 min-h-8 px-2.5 py-1",
        sm: "h-7 min-h-7 px-2 text-xs",
        lg: "h-9 min-h-9 px-3",
        icon: "h-8 w-8"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  readonly asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type = "button", ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size }), className)} ref={ref} type={asChild ? undefined : type} {...props} />;
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
