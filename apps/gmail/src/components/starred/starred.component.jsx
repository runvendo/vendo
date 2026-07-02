import React from "react";
import { connect } from "react-redux";
import { createStructuredSelector } from "reselect";
import { selectStarredRows } from "../../redux/mail/mail.selectors";
import StarList from "../star-list/star-list.component";
import { StarredContainer, NoItem, StarredHeading } from "./starred.styles";

const Starred = ({ starredItems }) => {
  return (
    <StarredContainer>
      {starredItems.length > 0 ? (
        <div>
          <StarredHeading>STARRED</StarredHeading>
          {starredItems.map((starred) => (
            <StarList key={starred.id} starred={starred} />
          ))}
        </div>
      ) : (
        <NoItem>Nothing In starred</NoItem>
      )}
    </StarredContainer>
  );
};

const mapStateToProps = createStructuredSelector({
  starredItems: selectStarredRows,
});
export default connect(mapStateToProps)(Starred);
