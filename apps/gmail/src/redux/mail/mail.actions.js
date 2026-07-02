import MailActionTypes from "./mail.types";

export const setMessages = (messages) => ({
  type: MailActionTypes.SET_MESSAGES,
  payload: messages,
});
