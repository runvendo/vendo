import React, { useState } from "react";
import { connect } from "react-redux";
import { addStarred } from "../../redux/starred/starred.actions";
import { createStructuredSelector } from "reselect";
import { changeStarColor } from "../../redux/starred/starred.selectors";
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

const MessageTemplate = ({ data, addStarred, changeStarColor }) => {
  const [toggle, setToggle] = useState("false");
  // console.log(changeStarColor);

  const handleClick = () => {
    // history.push("/starred");
    setToggle((prev) => !prev);

    addStarred(data);
  };

  return (
    <MessageTemplateContainer>
      <SquareBox className="square">
        <i className="far fa-square"></i>
      </SquareBox>
      <Star className={!toggle ? "star star-bg" : "star"} onClick={handleClick}>
        {!toggle ? (
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
        {/* <i className="far fa-star"></i> */}
      </Star>
      <MessageName>{data.name}</MessageName>

      <MessageBody>
        <MessageBodyFirst>
          <MessageTitle>{data.title}</MessageTitle>
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
        <Date className="date">{data.date}</Date>
      </MessageBody>
    </MessageTemplateContainer>
  );
};

const mapStateToProps = createStructuredSelector({
  changeStarColor,
});

const mapDispatchToProps = (dispatch) => ({
  addStarred: (star) => dispatch(addStarred(star)),
});

export default connect(mapStateToProps, mapDispatchToProps)(MessageTemplate);
