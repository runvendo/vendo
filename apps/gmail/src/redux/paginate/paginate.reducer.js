import PaginationActionTypes from "./paginate.types";
import { changePageNumber } from "./paginate.utils";

const INITIAL_STATE = {
  pageData: [],
  hidePromo: true,
  hideSocial: true,
};

const paginationReducer = (state = INITIAL_STATE, action) => {
  switch (action.type) {
    case PaginationActionTypes.CHANGE_PAGE:
      return {
        ...state,
        pageData: changePageNumber(action.payload),
      };

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
