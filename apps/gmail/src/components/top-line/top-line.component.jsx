import React from "react";
import { connect } from "react-redux";
import { createStructuredSelector } from "reselect";
import { selectInboxRows } from "../../redux/mail/mail.selectors";
import {
  TopLineContainer,
  TopLineLeft,
  TopIcon,
  Square,
  ArrowDown,
  Reload,
  TopLineRight,
  TopFigure,
  Greater,
  Lesser,
  Keyboard,
  RightArrowDown,
} from "./top-line.styles";

const TopLine = ({ inboxRows }) => {
  return (
    <TopLineContainer>
      <TopLineLeft>
        <Square>
          <TopIcon className="far fa-square"></TopIcon>
        </Square>
        <ArrowDown>
          <TopIcon className="fas fa-caret-down"></TopIcon>
        </ArrowDown>
        <Reload>
          <TopIcon className="fas fa-redo-alt"></TopIcon>
        </Reload>
        <span className="three-dot">
          <TopIcon className="fas fa-ellipsis-v"></TopIcon>
        </span>
      </TopLineLeft>
      <TopLineRight>
        <TopFigure>1-{inboxRows.length} of {inboxRows.length}</TopFigure>
        <Lesser>
          <TopIcon className="fas fa-less-than"></TopIcon>
        </Lesser>
        <Greater>
          <TopIcon className="fas fa-greater-than"></TopIcon>
        </Greater>
        <Keyboard>
          <TopIcon className="fas fa-keyboard"></TopIcon>
        </Keyboard>
        <RightArrowDown>
          <TopIcon className="fas fa-caret-down"></TopIcon>
        </RightArrowDown>
      </TopLineRight>
    </TopLineContainer>
  );
};

const mapStateToProps = createStructuredSelector({
  inboxRows: selectInboxRows,
});

export default connect(mapStateToProps)(TopLine);
