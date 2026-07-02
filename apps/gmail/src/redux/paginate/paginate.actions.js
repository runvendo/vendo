import PaginationActionTypes from "./paginate.types";

export const changePage = (value) => ({
  type: PaginationActionTypes.CHANGE_PAGE,
  payload: value,
});

export const hideSocial = () => ({
  type: PaginationActionTypes.HIDE_SOCIAL,
});

export const hidePromo = () => ({
  type: PaginationActionTypes.HIDE_PROMO,
});
