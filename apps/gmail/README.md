# Gmail clone (demo prop)

Vendored from [Tobi-davies/Gmail-Clone](https://github.com/Tobi-davies/Gmail-Clone) (CRA + Redux + styled-components; **no license declared upstream** — internal demo use only, do not ship or publish).

Local changes: bumped `react-scripts` 4→5 for Node 24, replaced `src/data.js` with believable 2026 demo inbox, renamed the account to Yousef.

## Run

```sh
cd apps/gmail
npm install   # plain npm — this app is excluded from the pnpm workspace (legacy deps)
PORT=3199 npm start
```

## What's real vs fake

- **Real:** inbox list (from `src/data.js`), starring → Starred view, compose popup → Send → Sent view, mobile responsive layout.
- **Fake/static:** search bar (no filtering), clicking an email does NOT open a read view, pagination arrows, category tabs (Social/Promotions), Drafts/Spam counts, all left-nav items besides Inbox/Starred/Sent.
- **No persistence:** state is in-memory Redux; a page reload resets stars and sent mail.
