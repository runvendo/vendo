import React from "react";
import CategoryBtn from "../category-buttons/category-button.component";
import MessageTemplate from "../message-template/message-template.component";
import { connect } from "react-redux";
import { createStructuredSelector } from "reselect";
import { selectInboxRows } from "../../redux/mail/mail.selectors";
import { InboxContainer } from "./inbox-content.styles";

const InboxContent = ({ currentMessages }) => {
  return (
    <InboxContainer>
      <CategoryBtn />
      {currentMessages.map((data) => (
        <MessageTemplate key={data.id} data={data} />
      ))}
    </InboxContainer>
  );
};

const mapStateToProps = createStructuredSelector({
  currentMessages: selectInboxRows,
});

export default connect(mapStateToProps)(InboxContent);
