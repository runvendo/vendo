import ShowOutboxTypes from "./outbox.types";

export const addSent = (sent) => ({
  type: ShowOutboxTypes.SHOW_OUTBOX,
  payload: sent,
});
