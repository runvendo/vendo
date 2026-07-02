import { createSelector } from "reselect";

const selectPage = (state) => state.paginate;

export const selectPageData = createSelector(
  [selectPage],
  (page) => page.pageData
);

export const selectSocial = createSelector(
  [selectPage],
  (page) => page.hideSocial
);

export const selectPromo = createSelector(
  [selectPage],
  (page) => page.hidePromo
);
