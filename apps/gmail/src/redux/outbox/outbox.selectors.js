import { createSelector } from "reselect";

const selectOutbox = (state) => state.outbox;

export const selectOutboxList = createSelector(
  [selectOutbox],
  (sent) => sent.sentMessages
);
