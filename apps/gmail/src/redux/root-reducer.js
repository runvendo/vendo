import { combineReducers } from "redux";
import mailReducer from "./mail/mail.reducer";
import paginationReducer from "./paginate/paginate.reducer";

export default combineReducers({
  // The server-backed mailbox (inbox/starred/sent all derive from it).
  mail: mailReducer,
  // Kept for the category-tab chip dismissal flags only.
  paginate: paginationReducer,
});
