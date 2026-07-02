import PaginationActionTypes from "./paginate.types";

// Kept as a no-op for the mobile nav's fake pagination taps: messages are
// server-backed now (mail slice), so the reducer ignores CHANGE_PAGE.
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
