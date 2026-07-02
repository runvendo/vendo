import styled from "styled-components";

export const TopLineContainer = styled.div`
  position: fixed;
  padding: 14px 20px 14px 5px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  right: 53px;
  left: 260px;
  background: #fff;
  border-bottom: 1px solid #f1f3f4;
  font-family: "Roboto", sans-serif;
  z-index: 3;

  @media screen and (max-width: 850px) {
    left: 230px;
  }

  @media screen and (max-width: 800px) {
    right: 0;
  }

  @media screen and (max-width: 700px) {
    right: 0;
    left: 200px;
  }

  @media screen and (max-width: 650px) {
    display: none;
  }
`;

export const TopLineLeft = styled.div`
  display: flex;
`;
export const TopIcon = styled.i`
  color: black;
  opacity: 0.54;
  cursor: pointer;
`;

export const Square = styled.div`
  padding-right: 10px;
  padding-left: 15px;
`;
export const ArrowDown = styled.div`
  padding-right: 28px;
`;
export const Reload = styled.div`
  padding-right: 28px;
`;

export const TopLineRight = styled.div`
  display: flex;
  align-items: center;
`;

export const TopFigure = styled.span`
  font-size: 14px;
  margin-right: 5px;
`;

export const Greater = styled.span`
  font-size: 0.7rem;
  padding: 0 15px;
`;
export const Lesser = styled.span`
  font-size: 0.7rem;
  padding: 0 15px;
`;

export const Keyboard = styled.span`
  padding-left: 15px;
`;

export const RightArrowDown = styled.span`
  font-size: 0.8rem;
  padding-left: 8px;
`;
