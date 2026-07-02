import MailActionTypes from "./mail.types";

// Mirror of the server's mailbox (the source of truth). `loaded` distinguishes
// "not fetched yet" from "genuinely empty" so views don't flash empty states.
const INITIAL_STATE = {
  messages: [],
  loaded: false,
};

const mailReducer = (state = INITIAL_STATE, action) => {
  switch (action.type) {
    case MailActionTypes.SET_MESSAGES:
      return {
        ...state,
        messages: action.payload,
        loaded: true,
      };
    default:
      return state;
  }
};

export default mailReducer;
