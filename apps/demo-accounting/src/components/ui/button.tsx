import { cn } from "@/lib/cn"

export type ButtonVariant = "primary" | "subtle"

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-evergreen-600 text-white hover:bg-evergreen-700",
  subtle: "border border-line bg-card text-ink-soft hover:bg-surface hover:text-ink",
}

/** Compact action button (checklist actions, composers). Defaults to type="button". */
export function Button({
  variant = "subtle",
  className,
  ...props
}: React.ComponentProps<"button"> & { variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-55",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  )
}
