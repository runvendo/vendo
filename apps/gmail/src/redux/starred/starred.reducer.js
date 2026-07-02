import ShowStarredTypes from "./starred.types";
import { addStarToList, removeStarredFromList } from "./starred.utils";

const INITIAL_STATE = {
  starredUpdate: [],
  starColor: false,
};

const starredReducer = (state = INITIAL_STATE, action) => {
  switch (action.type) {
    case ShowStarredTypes.SHOW_STARRED:
      return {
        ...state,
        starredUpdate: addStarToList(action.payload, state.starredUpdate),
        starColor: true,
      };

    case ShowStarredTypes.REMOVE_STARRED_MESSAGE:
      return {
        ...state,
        starredUpdate: removeStarredFromList(
          state.starredUpdate,
          action.payload
        ),
        starColor: false,
      };

    default:
      return state;
  }
};

export default starredReducer;
