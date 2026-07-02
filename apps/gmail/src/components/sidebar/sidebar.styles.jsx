import styled from "styled-components";

export const SidebarContainer = styled.div`
  width: 250px;
  position: fixed;
  left: 0;
  top: 62px;

  @media (max-width: 850px) {
    width: 220px;
  }

  @media (max-width: 700px) {
    width: 180px;
  }

  @media (max-width: 650px) {
    display: none;
  }
`;

export const ComposeButton = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 48px;
  width: 145px;
  border-radius: 25px;
  border: none;
  padding: 0 21px 0 12px;
  font-family: "Poppins", sans-serif;
  font-size: 0.83rem;
  font-weight: 500;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
  margin: 16px 0 16px 8px;
  cursor: pointer;
`;

export const ComposeImg = styled.div`
  background-image: url("https://www.gstatic.com/images/icons/material/colored_icons/1x/create_32dp.png");
  background-repeat: no-repeat;
  height: 30px;
  width: 40px;
`;

export const SideNavContainer = styled.ul`
  font-family: "Roboto", sans-serif;
  font-size: 14.5px;
  max-height: 210px;
  overflow-y: hidden;
  border-bottom: 1px solid #f1f3f4;

  & .highlight {
    font-weight: 600;
    background-color: #e0e2e2de;

    &:hover {
      background-color: #e0e2e2de;
    }
  }

  & .red-highlight {
    color: #d93025;
    background: #fceae9;
    font-weight: 600;

    .icon {
      margin-right: 17px;
    }
    &:hover {
      background: #fceae9;
    }
  }

  &:hover {
    border-top: 1px solid #f1f3f4;
    overflow-y: auto;
  }
`;

export const SideNavList = styled.li`
  padding: 4px 8px 4px 25px;
  display: flex;
  align-items: center;
  margin-right: 10px;
  color: #202124;
  border-bottom-right-radius: 20px;
  border-top-right-radius: 20px;
  cursor: pointer;

  & .number {
    margin-left: auto;
  }

  &:hover {
    background-color: #f1f3f4de;
  }
`;

export const ListImg = styled.img`
  opacity: 0.54;
  margin-right: 17px;
`;

export const Meet = styled.div`
  border-bottom: 1px solid #f1f3f4;
  font-family: "Roboto", sans-serif;
  font-size: 14.5px;

  padding: 14px 0 14px 0px;
`;

export const MeetText = styled.p`
  margin-bottom: 9px;
  padding-left: 25px;
`;

export const Hangout = styled.div`
  border-bottom: 1px solid #f1f3f4;
  font-family: "Roboto", sans-serif;
  font-size: 14.5px;
  padding: 14px 10px 14px 25px;
`;

export const HangoutText = styled.p`
  margin-bottom: 9px;
`;

export const HangoutFlex = styled.div`
  display: flex;
  align-items: center;
`;

export const CapitalT = styled.span`
  margin-right: 5px;
  background: rgb(23, 190, 182);
  padding: 6px 11px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 1rem;
  margin-bottom: 5px;
`;

export const HangoutName = styled.span`
  margin-right: 3px;
`;

export const HangoutCross = styled.span`
  margin-left: auto;
`;

export const HangoutArrow = styled.span`
  padding-bottom: 5px;
  opacity: 0.54;
`;
