import styled from "styled-components";

export const RightColumnContainer = styled.div`
  position: fixed;
  right: 0;
  top: 62px;
  height: 100vh;
  border-left: 1px solid #f1f3f4;

  @media screen and (max-width: 800px) {
    display: none;
  }
`;

export const ColumnItemGroup = styled.ul`
  display: flex;
  flex-direction: column;
  align-items: center;
`;

export const ColumnListItem = styled.li`
  padding: 15px;
`;
export const ColumnItemImage = styled.img`
  width: 20px;
  cursor: pointer;
`;

export const ColumnDash = styled.li`
  padding: 15px;
`;
export const Dash = styled.span`
  height: 1.5px;
  width: 22px;
  background: #f1f3f4;
  display: block;
`;
