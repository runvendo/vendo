import ShowOutboxTypes from "./outbox.types";
// import {addMessageToList} from './outbox.utils'

const INITIAL_STATE = {
  sentMessages: [],
};

const outboxReducer = (state = INITIAL_STATE, action) => {
  switch (action.type) {
    case ShowOutboxTypes.SHOW_OUTBOX:
      return {
        ...state,
        sentMessages: [action.payload, ...state.sentMessages],
      };

    default:
      return state;
  }
};

export default outboxReducer;
