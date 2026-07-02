import React, { useState } from "react";
import { AiOutlineArrowLeft } from "react-icons/ai";
import { BiPaperclip } from "react-icons/bi";
import { BiSend } from "react-icons/bi";
import { BsThreeDotsVertical } from "react-icons/bs";
import { Link, withRouter } from "react-router-dom";
import { connect } from "react-redux";
import { refreshMail, sendMessage } from "../../mail-api";
import {
  ComposeContainer,
  TopLinks,
  TopLinksLeft,
  TopText,
  TopLinksRight,
  MessageSection,
  MessageInputContainer,
  MessageInput,
  MessageInputText,
  SubjectInput,
  Body,
} from "./composeMessage.styles";

const ComposeMessage = ({ refresh, history }) => {
  const [composeDetails, setComposeDetails] = useState({
    to: "",
    subject: "",
    body: "",
  });

  const { to, subject, body } = composeDetails;

  const handleChange = (event) => {
    const { name, value } = event.target;
    setComposeDetails({ ...composeDetails, [name]: value });
  };

  const handleSubmit = (e) => {
    e.preventDefault();

    if (to !== "" && body !== "" && subject !== "") {
      sendMessage({ to, subject, body })
        .then(refresh)
        .then(() => history.push("/sent"))
        .catch(console.error);
      return;
    }

    history.push("/");
  };

  return (
    <ComposeContainer>
      <TopLinks>
        <TopLinksLeft>
          <Link to="/">
            <AiOutlineArrowLeft className="compose-icon" />
          </Link>
          <TopText>Compose</TopText>
        </TopLinksLeft>
        <TopLinksRight>
          <BiPaperclip className="compose-icon right" />
          <BiSend className="compose-icon right" onClick={handleSubmit} />
          <BsThreeDotsVertical className="compose-icon right" />
        </TopLinksRight>
      </TopLinks>
      <MessageSection>
        <MessageInputContainer>
          <MessageInput type="text" className="from-input" />
          <MessageInputText>From</MessageInputText>
        </MessageInputContainer>
        <MessageInputContainer>
          <MessageInput
            type="text"
            className="to-input"
            name="to"
            value={to}
            onChange={handleChange}
          />
          <MessageInputText>To</MessageInputText>
        </MessageInputContainer>
        <MessageInputContainer>
          <SubjectInput
            type="text"
            name="subject"
            value={subject}
            onChange={handleChange}
            className="subject-input"
            placeholder="Subject"
            required
          />
        </MessageInputContainer>
        <Body
          name="body"
          value={body}
          onChange={handleChange}
          placeholder="Compose email"
          required
        />
      </MessageSection>
    </ComposeContainer>
  );
};

const mapDispatchToProps = (dispatch) => ({
  refresh: () => refreshMail(dispatch),
});

export default withRouter(connect(null, mapDispatchToProps)(ComposeMessage));
