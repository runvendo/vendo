import styled, { css } from "styled-components";

const BottomBorder = css`
  height: 3px;
  width: 100%;
  position: absolute;
  bottom: 0;
  left: 0;
`;

const CategoryButton = css`
  height: 50px;
  width: 250px;
  background-repeat: no-repeat;
  border: none;
  outline: none;
  color: #777b80;
  font-family: "Roboto", sans-serif;
  font-size: 14.5px;
  font-weight: 600;
  position: relative;
  display: flex;
  align-items: center;
  padding: 7px 15px;
  background: #fff;

  &:hover {
    .dull {
      opacity: 1;
    }
  }
`;

export const CategoryButtonContainer = styled.div`
  display: flex;
  border-bottom: 1px solid #f1f3f4;

  @media (max-width: 650px) {
    display: none;
  }
`;

export const CategoryButton1 = styled.button`
  ${CategoryButton}
  color: ${({ color }) => (color === "red" ? "#d93025" : "none")};

  &:hover {
    color: ${({ color }) => (color !== "red" ? "#000" : "none")};
  }
`;
export const CategoryButton2 = styled.button`
  ${CategoryButton}
  color: ${({ color }) => (color === "blue" ? "#1a73e8" : "")};

  &:hover {
    color: ${({ color }) => (color !== "blue" ? "#000" : "")};
  }

  & .disappear {
    display: none;
  }
`;
export const CategoryButton3 = styled.button`
  ${CategoryButton}
  color: ${({ color }) => (color === "green" ? "#188038" : "")};

  &:hover {
    color: ${({ color }) => (color !== "green" ? "#000" : "none")};
  }
  & .clear {
    display: none;
  }
`;

export const ButtonImageContainer = styled.div`
  margin-right: 12px;

  & .dull {
    opacity: 0.55;
  }
`;

export const ButtonInfo = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
`;

export const ButtonInfoTop = styled.div`
  display: flex;
  align-items: center;

  & .new-social {
    background: #1a73e8;
  }

  & .new-promo {
    background: #188038;
  }

  @media screen and (max-width: 900px) {
    .promotion-title {
      width: 50px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }
`;

export const ButtonInfoBottom = styled.div`
  font-size: 12px;
  font-family: "Roboto", sans-serif;
  opacity: 0.6;
  font-weight: normal;
`;

export const ButtonInfoTitle = styled.p`
  font-family: "Roboto", sans-serif;
  margin-left: 5px;
  font-size: 12px;
  color: #fff;
  padding: 1px 2.5px;
`;

export const BottomBorder1 = styled.div`
  ${BottomBorder}
  background: ${({ color }) => (color === "red" ? "#d93025" : "none")};
`;

export const BottomBorder2 = styled.div`
  ${BottomBorder}
  background: ${({ color }) => (color === "blue" ? "#1a73e8" : "none")};
`;

export const BottomBorder3 = styled.div`
  ${BottomBorder}
  background: ${({ color }) => (color === "green" ? "#188038" : "none")}
`;
