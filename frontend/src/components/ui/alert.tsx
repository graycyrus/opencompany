import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const alertVariants = cva(
  "group/alert relative grid w-full gap-0.5 rounded-lg border px-2.5 py-2 text-left text-sm has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        /*
         * Something is wrong but nothing has failed — a setting that will be
         * stored and do nothing, a build missing the feature it configures.
         *
         * These were `default`, which paints a card: an alert with a warning
         * triangle in it, in the same grey as the panel it sits on, reads as a
         * caption rather than as a warning, and the one thing it has to do is
         * be noticed. `destructive` is the wrong end — nothing here has broken
         * or been refused — so this is the amber the console already uses for
         * "blocked" everywhere else (`--status-blocked`), tinted rather than
         * filled so it still reads as a notice on the page and not an error
         * dialog.
         */
        warning:
          "border-status-blocked/40 bg-status-blocked-soft text-foreground " +
          "*:data-[slot=alert-description]:text-muted-foreground *:[svg]:text-status-blocked-text",
        destructive:
          "bg-card text-destructive *:data-[slot=alert-description]:text-destructive/90 *:[svg]:text-current",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  // `role="alert"` is an assertive live region, so hard-coding it on every Alert
  // made a standing informational notice — one present on mount, like the
  // "Saved to this browser as a draft" note on Settings — interrupt a screen
  // reader on page load even though nothing had changed (issue #1392).
  //
  // The default is `role="status"`, not no role at all: a polite live region is
  // silent for a notice that is already there when the page renders, but still
  // announces one mounted in response to something the operator did — the
  // feedback form's success alert after Send, or the warning that appears when
  // the last teammate is removed in the setup wizard. Dropping the role
  // outright would have made those silent.
  return (
    <div
      data-slot="alert"
      role={variant === "destructive" ? "alert" : "status"}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-sm text-balance text-muted-foreground md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
        className
      )}
      {...props}
    />
  )
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn("absolute top-2 right-2", className)}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, AlertAction }
