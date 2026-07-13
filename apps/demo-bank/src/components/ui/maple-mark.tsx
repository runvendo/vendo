import { Leaf } from "lucide-react"

/** Maple brand mark: a clean leaf glyph. Renders in the current text color. */
export function MapleMark({ className }: { className?: string }) {
  return <Leaf className={className} strokeWidth={2.25} aria-hidden="true" />
}
