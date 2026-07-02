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
} from "./message-template.styles";

const MessageTemplate = ({ data, refresh, history }) => {
  const handleStar = (event) => {
    event.stopPropagation();
    setStar(data.id, !data.starred).then(refresh).catch(console.error);
  };

  const openMessage = () => {
    history.push(`/message/${data.id}`);
  };

  const emphasis = data.unread ? { fontWeight: 700 } : {};

  return (
    <MessageTemplateContainer
      onClick={openMessage}
      style={{ cursor: "pointer", background: data.unread ? "#ffffff" : "#f6f7f8" }}
    >
      <SquareBox className="square" onClick={(e) => e.stopPropagation()}>
        <i className="far fa-square"></i>
      </SquareBox>
      <Star className={data.starred ? "star star-bg" : "star"} onClick={handleStar}>
        {data.starred ? (
          <img
            src="https://www.gstatic.com/images/icons/material/system/1x/star_googyellow500_20dp.png"
            alt="star"
            className="yellow"
          />
        ) : (
          <img
            src="https://www.gstatic.com/images/icons/material/system/1x/star_border_black_20dp.png"
            alt="star"
            className="dark"
          />
        )}
      </Star>
      <MessageName style={emphasis}>{data.name}</MessageName>

      <MessageBody>
        <MessageBodyFirst>
          <MessageTitle style={emphasis}>{data.title}</MessageTitle>
          <Dash>-</Dash>
          <MessageContent>{data.body}</MessageContent>
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
        <Date className="date" style={emphasis}>{data.date}</Date>
      </MessageBody>
    </MessageTemplateContainer>
  );
};

const mapDispatchToProps = (dispatch) => ({
  refresh: () => refreshMail(dispatch),
});

export default withRouter(connect(null, mapDispatchToProps)(MessageTemplate));
