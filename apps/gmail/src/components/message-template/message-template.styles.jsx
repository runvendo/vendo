import styled from "styled-components";

export const MessageTemplateContainer = styled.div`
  display: flex;
  align-items: center;
  position: relative;
  padding: 0 15px 0 15px;
  font-family: "Roboto", sans-serif;
  background: #fff;
  border-bottom: 1px solid #f1f3f4;
  cursor: pointer;

  &:hover {
    border: 1px solid rgba(0, 0, 0, 0.2);
    box-shadow: 0 2px 3px rgba(0, 0, 0, 0.4);
    z-index: 2;

    & .date {
      display: none;
    }
    & .dark {
      opacity: 0.6;
    }

    & .yellow {
      &:hover {
        opacity: 1;
        // background: #ddd;
        // padding: 1px;
        // border-radius: 50%;
      }
    }
    & .square {
      opacity: 0.6;
    }

    & .date-icons {
      width: 150px;
      display: flex;
      margin-left: auto;
    }
  }

  @media screen and (max-width: 850px) {
    flex-direction: column;
    align-items: flex-start;
    padding-top: 10px;
    padding-bottom: 35px;
  }

  @media screen and (max-width: 700px) {
    padding-top: 14px;
    padding-bottom: 40px;
    border-bottom: none;

    &:hover {
      border: unset;
      box-shadow: unset;
      background: rgb(243, 243, 243);

      & .date-icons {
        display: none;
      }

      & .date {
        display: unset;
      }
      & .square {
        padding: 0px 0 10px 5px;
      }
    }
  }
`;

export const SquareBox = styled.span`
  opacity: 0.16;
  margin-right: 13px;
  font-size: 1.1rem;
  padding: 10px 0 10px;

  @media screen and (max-width: 850px) {
    padding: 0px 0 10px;
    position: relative;
  }
`;

export const Star = styled.button`
  background: none;
  outline: none;
  border: none;
  font-size: 1rem;
  margin-right: 13px;

  & .dark {
    opacity: 0.16;
  }

  & .yellow {
    opacity: 0.7;
  }

  @media screen and (max-width: 850px) {
    position: absolute;
    right: 0px;
    bottom: 5px;
  }

  @media screen and (max-width: 700px) {
    right: 5px;
  }
`;

export const HoverIcons = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  display: none;

  & img {
    padding: 8px;
    opacity: 0.54;

    &:hover {
      opacity: 1;
      background: rgb(230, 227, 227);
      border-radius: 50%;
    }
  }

  @media screen and (max-width: 850px) {
    position: absolute;
    right: 0px;

    top: 0;
  }
`;

export const MessageName = styled.p`
  font-size: 14.5px;
  min-width: 210px;
  font-weight: 500;
  position: relative;
  flex-shrink: 0;

  @media screen and (max-width: 850px) {
    position: absolute;
    left: 40px;
    top: 10px;
  }
  @media screen and (max-width: 700px) {
    position: absolute;
    left: 50px;
    top: 15px;
    font-size: 15px;
  }
`;

export const MessageTitle = styled.span`
  font-weight: 500;
  @media screen and (max-width: 850px) {
    margin-bottom: 2px;
  }
`;

export const MessageBody = styled.div`
  flex: 1;
  font-size: 14.5px;
  display: flex;
  align-items: center;
  overflow: hidden;
`;

export const MessageBodyFirst = styled.div`
  display: flex;
  width: 88%;
  white-space: nowrap;
  overflow: hidden;

  @media screen and (max-width: 850px) {
    display: flex;
    flex-direction: column;
    position: absolute;
    top: 30px;
    left: 40px;
    width: 80%;
  }

  @media screen and (max-width: 700px) {
    left: 50px;
    width: 72%;
    top: 35px;
    font-size: 15px;
  }
`;
export const MessageContent = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
`;

export const Dash = styled.span`
  padding: 0 4px 0 4px;

  @media screen and (max-width: 850px) {
    display: none;
  }
`;

export const Date = styled.p`
  display: block;
  font-size: 12px;
  margin-left: auto;
  width: 80px;
  text-align: end;
  font-weight: 500;

  @media screen and (max-width: 850px) {
    position: absolute;
    right: 13px;
    top: 10px;
  }

  @media screen and (max-width: 700px) {
    right: 20px;
    font-size: 15px !important;
  }
`;
