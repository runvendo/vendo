import React from "react";
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

const SentMessages = ({ item }) => {
  return (
    <MessageTemplateContainer>
      <SquareBox className="square">
        <i className="far fa-square"></i>
      </SquareBox>
      <Star className="star">
        {/* {!toggle ? (
          <img
            src="https://www.gstatic.com/images/icons/material/system/1x/star_googyellow500_20dp.png"
            alt="star"
          />
        ) : (
          <img
            src="https://www.gstatic.com/images/icons/material/system/1x/star_border_black_20dp.png"
            alt="star"
          />
        )} */}
        <i className="far fa-star dark"></i>
      </Star>
      <MessageName>{item.to}</MessageName>

      <MessageBody>
        <MessageBodyFirst>
          <MessageTitle>{item.subject}</MessageTitle>
          <Dash>-</Dash>
          <MessageContent>{item.body}</MessageContent>
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
        <Date className="date">{item.month}</Date>
        {/* <p className="message-title">To: {item.to}</p>
      <p className="message-body">
        {item.subject} - {item.body}
      </p>
      <p className="date">{item.month}</p>  */}
      </MessageBody>
    </MessageTemplateContainer>
  );
};

export default SentMessages;
