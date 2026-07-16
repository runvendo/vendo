// PLACEHOLDER — the demo creator rewrites everything visible per prospect,
// EXCEPT the demo chrome (src/components/demo-chrome.tsx + the beat chips in
// src/components/suggestion-chips.tsx): the badge, CTA, and caps limit card
// are fenced plumbing and must survive the rewrite. This page exists only so
// the app builds and runs; no brand, copy, or product surface here is meant
// to survive a real demo generation pass.
export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-2 p-8 text-center">
      <h1 className="text-xl font-semibold tracking-tight text-ink">demo-template</h1>
      <p className="text-sm text-muted">
        PLACEHOLDER — the demo creator rewrites everything visible.
      </p>
      <a href="/vendo" className="text-sm underline underline-offset-4">
        Open the Vendo panel →
      </a>
    </div>
  )
}
