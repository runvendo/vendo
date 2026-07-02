import ShowStarredTypes from "./starred.types";

export const addStarred = (star) => ({
  type: ShowStarredTypes.SHOW_STARRED,
  payload: star,
});

export const removeStarred = (star) => ({
  type: ShowStarredTypes.REMOVE_STARRED_MESSAGE,
  payload: star,
});
