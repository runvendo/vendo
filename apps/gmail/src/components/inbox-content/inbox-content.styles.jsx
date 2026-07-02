import styled from "styled-components";

export const InboxContainer = styled.div`
  width: 100%;
  margin-top: 48px;
  display: flex;
  flex-direction: column;
  overflow-y: auto;

  @media (max-width: 650px) {
    margin-top: 20px;
  }
`;
