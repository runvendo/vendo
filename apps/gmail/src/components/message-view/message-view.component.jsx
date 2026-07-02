import React, { useEffect } from "react";
import { connect } from "react-redux";
import { withRouter } from "react-router-dom";
import { AiOutlineArrowLeft, AiOutlineDelete, AiFillStar, AiOutlineStar } from "react-icons/ai";
import { deleteMessage, markRead, refreshMail, setStar } from "../../mail-api";
import { dateLabel, selectMailLoaded, selectMessageById } from "../../redux/mail/mail.selectors";
import {
  ViewContainer,
  ViewToolbar,
  ViewSubjectRow,
  FolderChip,
  SenderRow,
  Avatar,
  SenderMeta,
  ViewDate,
  ViewBody,
  NotFound,
} from "./message-view.styles";

/** Stable pastel hue per sender so avatars look consistent, Gmail-style. */
const hueFor = (text) => {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) % 360;
  return h;
};

const MessageView = ({ message, loaded, refresh, history }) => {
  const id = message && message.id;
  const unread = message && message.unread;

  // Opening a message reads it — same as Gmail.
  useEffect(() => {
    if (id && unread) {
      markRead(id, true).then(refresh).catch(console.error);
    }
  }, [id, unread, refresh]);

  if (!loaded) return null;
  if (!message) return <NotFound>This message was moved or deleted.</NotFound>;

  const handleDelete = () => {
    deleteMessage(message.id)
      .then(refresh)
      .then(() => history.push("/"))
      .catch(console.error);
  };

  const handleStar = () => {
    setStar(message.id, !message.starred).then(refresh).catch(console.error);
  };

  const fullDate = new Date(message.date).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <ViewContainer>
      <ViewToolbar>
        <span className="view-icon" onClick={() => history.goBack()} title="Back">
          <AiOutlineArrowLeft />
        </span>
        <span className="view-icon" onClick={handleDelete} title="Delete">
          <AiOutlineDelete />
        </span>
        <span className="view-icon" onClick={handleStar} title="Star">
          {message.starred ? <AiFillStar color="#f4b400" /> : <AiOutlineStar />}
        </span>
      </ViewToolbar>

      <ViewSubjectRow>
        <h2>{message.subject}</h2>
        <FolderChip>{message.folder === "sent" ? "Sent" : "Inbox"}</FolderChip>
      </ViewSubjectRow>

      <SenderRow>
        <Avatar hue={hueFor(message.from.email)}>
          {message.from.name.charAt(0).toUpperCase()}
        </Avatar>
        <SenderMeta>
          <div className="sender-line">
            <span className="sender-name">{message.from.name}</span>
            <span className="sender-email">&lt;{message.from.email}&gt;</span>
          </div>
          <div className="to-line">
            to {message.to.map((t) => (t.email === "yousef@acmelabs.dev" ? "me" : t.name)).join(", ")}
          </div>
        </SenderMeta>
        <ViewDate>{fullDate} ({dateLabel(message.date)})</ViewDate>
      </SenderRow>

      <ViewBody>{message.body}</ViewBody>
    </ViewContainer>
  );
};

const mapStateToProps = (state, ownProps) => ({
  message: selectMessageById(ownProps.match.params.id)(state),
  loaded: selectMailLoaded(state),
});

const mapDispatchToProps = (dispatch) => ({
  refresh: () => refreshMail(dispatch),
});

export default withRouter(connect(mapStateToProps, mapDispatchToProps)(MessageView));
