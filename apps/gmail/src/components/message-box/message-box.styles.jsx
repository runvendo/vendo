import styled from "styled-components";

export const MessageBoxContainer = styled.div`
  width: 440px;
  height: 468px;
  background: #fff;
  position: fixed;
  z-index: 3;
  right: 67px;
  bottom: 0;
  border-top-left-radius: 10px;
  border-top-right-radius: 10px;
  box-shadow: 0 3px 8px rgba(0, 0, 0, 0.5);
  font-family: "Roboto", sans-serif;
  display: ${({ showMessage }) => (showMessage ? "none" : "block")};

  @media (max-width: 650px) {
    display: none;
  }
`;

export const MessageBoxTop = styled.div`
  background-color: #2d2e30;
  border-top-left-radius: 10px;
  border-top-right-radius: 10px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 15px;
`;

export const MessageBoxTopText = styled.p`
  color: white;
  font-size: 15px;
`;

export const MessageBoxTopIcons = styled.div`
  display: flex;

  & .fas {
    color: #fff;
    opacity: 0.54;
    font-size: 0.9rem;
    padding-left: 11px;
    cursor: pointer;
  }
`;

export const MessageBoxForm = styled.form`
  padding: 0 17px;
`;

export const MessageBoxInput = styled.input`
  border: none;
  outline: none;
  width: 100%;
  background: #fff;
  height: 35px;
  font-size: 16px;
  font-family: "Roboto", sans-serif;
  border-bottom: 1px solid #f1f3f4;

  &::placeholder {
    font-size: 15px;
    font-family: "Roboto", sans-serif;
  }
  &:active {
    background: #fff;
  }
`;

export const MessageTextarea = styled.textarea`
  width: 100%;
  outline: none;
  border: none;
  margin-top: 10px;
  font-size: 16px;
  font-family: "Roboto", sans-serif;
  background: #fff;
`;

export const MessageBoxBottom = styled.div`
  margin-top: 7px;
  display: flex;
  align-items: center;
`;

export const MessageSendButton = styled.button`
  padding: 10px 7px 10px 17px;
  border-radius: 4px;
  outline: none;
  border: none;
  background: #1a73e8;
  color: #fff;
  font-family: "Roboto", sans-serif;
  margin-right: 5px;
  font-weight: bold;
`;
export const MessageSendButtonText = styled.span`
  padding-right: 10px;
  border-right: 1px solid rgb(63, 63, 63);
`;

export const MessageSendButtonIcon = styled.span`
  padding-left: 7px;
`;

export const BottomLeftIcons = styled.img`
  opacity: 0.54;
  padding: 0 6px;
  cursor: pointer;
`;

export const BottomRight = styled.div`
  margin-left: auto;
`;

export const BottomRightIcons = styled.img`
  opacity: 0.54;
  padding-left: 5px;
  cursor: pointer;
`;
