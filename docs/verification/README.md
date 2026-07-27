# Verification evidence

Written verification records live here: per-campaign `README.md` files,
timing tables, transport logs, and store assertions. They are small, they
diff, and they explain what was proven.

**Media does not.** Screenshots, GIFs, and screen recordings are review
artifacts with a lifespan of one pull request. Committing them grew this
directory to 126MB — enough to break container-image uploads — so they are
gitignored (see the `docs/verification/**` rules in `.gitignore`) and were
removed from the tree on 2026-07-27.

Where to put media instead:

- **In the PR.** Drag images into the PR description or a review comment.
  That is where reviewers actually look, and GitHub hosts them.
- **Locally, for a lane's own record.** Keep them in the lane worktree or
  under the factory evidence directory outside the repo.

If a screenshot genuinely belongs in permanent documentation (a docs-site
page, a README diagram), put it under `docs/assets/` or the docs site's own
image directory — those are curated and reviewed, not per-run evidence.

Historical note: the media removed in the cleanup is still reachable in git
history if an old campaign's screenshots are ever needed; nothing was
rewritten.
