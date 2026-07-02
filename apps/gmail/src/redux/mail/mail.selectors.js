import { createSelector } from "reselect";

const TZ = "America/Los_Angeles";

/** Gmail-style date column: time for today's mail, "Jul 1" otherwise. */
export const dateLabel = (iso) => {
  const d = new Date(iso);
  const now = new Date();
  const day = (x) => x.toLocaleDateString("en-US", { timeZone: TZ });
  if (day(d) === day(now)) {
    return d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric" });
};

/** Map a server message to the display shape the list rows render. */
const toRow = (m) => ({
  id: m.id,
  name: m.from.name,
  to: m.to[0] ? m.to[0].name : "",
  title: m.subject,
  body: m.snippet,
  date: dateLabel(m.date),
  unread: m.unread,
  starred: m.starred,
  folder: m.folder,
});

const selectMail = (state) => state.mail;

export const selectMessages = createSelector([selectMail], (mail) => mail.messages);
export const selectMailLoaded = createSelector([selectMail], (mail) => mail.loaded);

export const selectInboxRows = createSelector([selectMessages], (messages) =>
  messages.filter((m) => m.folder === "inbox").map(toRow)
);

export const selectStarredRows = createSelector([selectMessages], (messages) =>
  messages.filter((m) => m.starred && m.folder !== "trash").map(toRow)
);

export const selectSentRows = createSelector([selectMessages], (messages) =>
  messages.filter((m) => m.folder === "sent").map(toRow)
);

export const selectUnreadCount = createSelector(
  [selectMessages],
  (messages) => messages.filter((m) => m.folder === "inbox" && m.unread).length
);

export const selectMessageById = (id) =>
  createSelector([selectMessages], (messages) => messages.find((m) => m.id === id));
