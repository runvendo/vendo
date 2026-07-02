import React from "react";
import { connect } from "react-redux";
import { withRouter } from "react-router-dom";
import { refreshMail, setStar } from "../../mail-api";
import {
  MessageTemplateContainer,
  SquareBox,
  Star,
  HoverIcons,
  MessageBody,
  MessageBodyFirst,
  MessageTitle,
  MessageName,
  MessageContent,
  Dash,
  Date,
} from "../message-template/message-template.styles";

const StarList = ({ starred, refresh, history }) => {
  const handleRemoval = (event) => {
    event.stopPropagation();
    setStar(starred.id, false).then(refresh).catch(console.error);
  };

  return (
    <MessageTemplateContainer
      onClick={() => history.push(`/message/${starred.id}`)}
      style={{ cursor: "pointer" }}
    >
      <SquareBox className="square" onClick={(e) => e.stopPropagation()}>
        <i className="far fa-square"></i>
      </SquareBox>
      <Star className="star" onClick={handleRemoval}>
        <img
          src="https://www.gstatic.com/images/icons/material/system/1x/star_googyellow500_20dp.png"
          alt="star"
          className="yellow"
        />
      </Star>
      <MessageName>{starred.name}</MessageName>
      <MessageBody>
        <MessageBodyFirst>
          <MessageTitle>{starred.title}</MessageTitle>
          <Dash>-</Dash>
          <MessageContent>{starred.body}</MessageContent>
        </MessageBodyFirst>
        <HoverIcons className="date-icons">
          <img
            src="https://www.gstatic.com/images/icons/material/system/1x/archive_black_20dp.png"
            alt="download-icon"
          />
          <img
            src="https://www.gstatic.com/images/icons/material/system/1x/delete_black_20dp.png"
            alt="thrash-icon"
          />
          <img
            src="https://www.gstatic.com/images/icons/material/system/1x/mark_as_unread_black_20dp.png"
            alt="mail-open-icon"
          />
          <img
            src="https://www.gstatic.com/images/icons/material/system/1x/watch_later_black_20dp.png"
            alt="snooze-icon"
          />
        </HoverIcons>
        <Date className="date">{starred.date}</Date>
      </MessageBody>
    </MessageTemplateContainer>
  );
};

const mapDispatchToProps = (dispatch) => ({
  refresh: () => refreshMail(dispatch),
});

export default withRouter(connect(null, mapDispatchToProps)(StarList));
