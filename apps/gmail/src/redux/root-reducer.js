import { combineReducers } from "redux";
import starredReducer from "./starred/starred.reducer";
import outboxReducer from "./outbox/outbox.reducer";
import paginationReducer from "./paginate/paginate.reducer";

export default combineReducers({
  starred: starredReducer,
  outbox: outboxReducer,
  paginate: paginationReducer,
});
