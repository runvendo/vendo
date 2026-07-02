import React, { useState } from "react";
// import "./message-box.styles.css";
import { connect } from "react-redux";
import { addSent } from "../../redux/outbox/outbox.actions";
import {
  MessageBoxContainer,
  MessageBoxTop,
  MessageBoxTopText,
  MessageBoxTopIcons,
  MessageBoxForm,
  MessageBoxInput,
  MessageTextarea,
  MessageBoxBottom,
  MessageSendButton,
  MessageSendButtonText,
  MessageSendButtonIcon,
  BottomLeftIcons,
  BottomRight,
  BottomRightIcons,
} from "./message-box.styles";

const MessageBox = ({ showMessage, shouldMessageShow, addSent }) => {
  let monthList = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sept",
    "Oct",
    "Nov",
    "Dec",
  ];

  const formatDate = (item) => {
    if (item < 10) {
      return (item = `0${item}`);
    }
    return item;
  };

  let today = new Date();
  let date = formatDate(today.getDate());
  let month = monthList[today.getMonth()];
  let timeSent = `${month} ${date}`;
  // console.log(month);

  const [messageDetail, updateMessageDetail] = useState({
    to: "",
    subject: "",
    body: "",
    month: timeSent,
  });

  const { to, subject, body } = messageDetail;

  // const [receiver, setTo] = useState("");
  // const [topic, setSubject] = useState("");
  // const [content, setBody] = useState("");

  const handleChange = (event) => {
    const { name, value } = event.target;

    updateMessageDetail({ ...messageDetail, [name]: value });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    // updateMessageDetail({
    //   to: receiver,
    //   subject: topic,
    //   body: content,
    // });

    // const data = {
    //   to: receiver,
    //   subject: topic,
    //   body: content,
    //   month: timeSent,
    // };

    if (to !== "" && body !== "" && subject !== "") {
      shouldMessageShow(true);
      addSent(messageDetail);
    }

    updateMessageDetail({
      to: "",
      subject: "",
      body: "",
      month: timeSent,
    });
  };

  // const handleChange = (event) => {
  //   // const { name, value } = event.target;

  //   updateMessageDetail({ [event.target.name]: event.target.value });
  // };

  const handleClose = () => {
    shouldMessageShow(true);
    updateMessageDetail({
      to: "",
      subject: "",
      body: "",
      month: timeSent,
    });
  };

  return (
    <MessageBoxContainer showMessage={showMessage}>
      <MessageBoxTop>
        <MessageBoxTopText>New Message</MessageBoxTopText>
        <MessageBoxTopIcons>
          <i className="fas fa-minus"></i>
          <i className="fas fa-expand-alt"></i>
          <i className="fas fa-times close" onClick={handleClose}></i>
        </MessageBoxTopIcons>
      </MessageBoxTop>
      <MessageBoxForm onSubmit={handleSubmit}>
        <MessageBoxInput
          type="text"
          name="to"
          value={to}
          onChange={handleChange}
          placeholder="To"
          required
        />
        <MessageBoxInput
          type="text"
          name="subject"
          value={subject}
          onChange={handleChange}
          placeholder="Subject"
          required
        />
        <MessageTextarea
          name="body"
          value={body}
          onChange={handleChange}
          rows="15"
          required
        />

        <MessageBoxBottom>
          <MessageSendButton type="submit">
            <MessageSendButtonText>Send</MessageSendButtonText>
            <MessageSendButtonIcon>
              <i className="fas fa-caret-down"></i>
            </MessageSendButtonIcon>
          </MessageSendButton>
          <BottomLeftIcons
            src="https://www.gstatic.com/images/icons/material/system/1x/text_format_black_20dp.png"
            alt="icon"
          />

          <BottomLeftIcons
            src="https://www.gstatic.com/images/icons/material/system/1x/attach_file_black_20dp.png"
            alt="icon"
          />

          <BottomLeftIcons
            src="https://www.gstatic.com/images/icons/material/system/1x/insert_link_black_20dp.png"
            alt="icon"
          />

          <BottomLeftIcons
            src="https://www.gstatic.com/images/icons/material/system/1x/insert_emoticon_black_20dp.png"
            alt="icon"
          />

          <BottomLeftIcons
            src="https://www.gstatic.com/images/icons/material/system/1x/drive_black_20dp.png"
            alt="icon"
          />

          <BottomLeftIcons
            src="https://www.gstatic.com/images/icons/material/system/1x/insert_photo_black_20dp.png"
            alt="icon"
          />

          <BottomLeftIcons
            src="https://www.gstatic.com/images/icons/material/system/1x/lock_clock_black_20dp.png"
            alt="icon"
          />
          <BottomRight>
            <BottomRightIcons
              src="https://www.gstatic.com/images/icons/material/system/1x/more_vert_black_20dp.png"
              alt="icon"
            />

            <BottomRightIcons
              src="https://www.gstatic.com/images/icons/material/system/1x/delete_black_20dp.png"
              alt="icon"
            />
          </BottomRight>
        </MessageBoxBottom>
      </MessageBoxForm>
    </MessageBoxContainer>
  );
};

const mapDispatchToProps = (dispatch) => ({
  addSent: (sent) => dispatch(addSent(sent)),
});

export default connect(null, mapDispatchToProps)(MessageBox);
