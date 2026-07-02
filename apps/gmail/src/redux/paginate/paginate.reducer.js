import PaginationActionTypes from "./paginate.types";

// Messages now live in the mail slice (server-backed); this reducer only
// keeps the category-tab "new" chip dismissal flags.
const INITIAL_STATE = {
  hidePromo: true,
  hideSocial: true,
};

const paginationReducer = (state = INITIAL_STATE, action) => {
  switch (action.type) {
    case PaginationActionTypes.HIDE_SOCIAL:
      return {
        ...state,
        hideSocial: false,
      };

    case PaginationActionTypes.HIDE_PROMO:
      return {
        ...state,
        hidePromo: false,
      };

    default:
      return state;
  }
};

export default paginationReducer;
