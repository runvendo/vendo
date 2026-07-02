import styled, { css } from "styled-components";

const InputStyle = css`
  height: 7vh;
  border: none;
  border-bottom: 2px solid #f1f3f4;
  width: 100%;
  padding-left: 70px;
  font-family: "Roboto", sans-serif;
  outline: none;
  font-size: 16px;
  padding-top: 3px;
`;

export const ComposeContainer = styled.div`
  position: relative;
  top: 0;
  left: 0;
  height: 100vh;
  width: 100vw;
  padding: 20px 0;
  font-family: "Roboto", sans-serif;
`;

export const TopLinks = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 10px;
`;

export const TopLinksLeft = styled.div`
  display: flex;
  align-items: center;

  & .compose-icon {
    color: #000;
    opacity: 0.7;
    font-size: 1.2rem;
  }
`;

export const TopText = styled.p`
  font-size: 1.2rem;
  margin-left: 25px;
`;

export const TopLinksRight = styled.div`
  & .right {
    margin-left: 15px;
    color: #000;
    opacity: 0.7;
    font-size: 1.2rem;
  }
`;

export const MessageSection = styled.form`
  display: flex;
  flex-direction: column;
  width: 100%;
  margin-top: 10px;
`;
export const MessageInput = styled.input`
  ${InputStyle}
`;
export const MessageInputContainer = styled.div`
  position: relative;
`;

export const MessageInputText = styled.p`
  position: absolute;
  top: 0%;
  left: 5%;
  height: 100%;
  display: flex;
  align-items: center;
`;

export const SubjectInput = styled.input`
  ${InputStyle}
  padding-left: 22px;
`;

export const Body = styled.textarea`
  height: 50vh;
  border: none;
  width: 100%;
  padding-top: 20px;
  padding-left: 20px;
  font-family: "Roboto", sans-serif;
  font-size: 16px;
  outline: none;
`;
