import React from "react";
// import "./star-list.styles.css";
import { connect } from "react-redux";
import { removeStarred } from "../../redux/starred/starred.actions";
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

const StarList = ({ starred, removeStarred }) => {
  const handleRemoval = () => {
    removeStarred(starred);
  };

  return (
    <MessageTemplateContainer>
      <SquareBox className="square">
        <i className="far fa-square"></i>
      </SquareBox>
      <Star className="star" onClick={handleRemoval}>
        {/* {!toggle ? (
              <img
                src="https://www.gstatic.com/images/icons/material/system/1x/star_border_black_20dp.png"
                alt="star"
              />
            ) : (
              <img
                src="https://www.gstatic.com/images/icons/material/system/1x/star_googyellow500_20dp.png"
                alt="star"
              />
            )} */}
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
        <Date className="date">26 Jan</Date>
      </MessageBody>
    </MessageTemplateContainer>
  );
};

const mapDispatchToProps = (dispatch) => ({
  removeStarred: (unstar) => dispatch(removeStarred(unstar)),
});

export default connect(null, mapDispatchToProps)(StarList);
