import React from "react";
import { connect } from "react-redux";
import { createStructuredSelector } from "reselect";
import { selectSentRows } from "../../redux/mail/mail.selectors";
import SentMessages from "../sent-messages/sent-messages.component";
import { SentContainer, NoItem, Heading } from "./sent.styles";

const Sent = ({ sentItems }) => {
  return (
    <SentContainer>
      {sentItems.length > 0 ? (
        <div>
          <Heading>SENT</Heading>
          {sentItems.map((item) => (
            <SentMessages key={item.id} item={item} />
          ))}
        </div>
      ) : (
        <NoItem>Nothing in Sent</NoItem>
      )}
    </SentContainer>
  );
};

const mapStateToProps = createStructuredSelector({
  sentItems: selectSentRows,
});

export default connect(mapStateToProps)(Sent);
