import React from "react";
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

const TopLine = () => {
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
        <TopFigure>1-50 of 51</TopFigure>
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

export default TopLine;
