import React from "react";
import { connect } from "react-redux";
import { createStructuredSelector } from "reselect";
import { selectOutboxList } from "../../redux/outbox/outbox.selectors";
import SentMessages from "../sent-messages/sent-messages.component";
import { SentContainer, NoItem, Heading } from "./sent.styles";

const Sent = ({ sentItems }) => {
  return (
    <SentContainer>
      {sentItems.length > 0 ? (
        <div>
          <Heading>SENT</Heading>
          {sentItems.map((item, index) => (
            <SentMessages key={index} item={item} />
          ))}
        </div>
      ) : (
        <NoItem>Nothing in Sent</NoItem>
      )}
    </SentContainer>
  );
};

const mapStateToProps = createStructuredSelector({
  sentItems: selectOutboxList,
});

export default connect(mapStateToProps)(Sent);
