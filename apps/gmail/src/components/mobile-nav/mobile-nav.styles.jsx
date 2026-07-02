import styled from "styled-components";

// transform: ${({ mobileNav }) =>
// mobileNav ? "translateX(0)" : "translateX(-100vh)"}

// display: ${({ mobileNav }) => (!mobileNav ? "none" : "block")};

export const Nav = styled.div`
  display: none;

  @media screen and (max-width: 650px) {
    display: block;
    transform: translateX(0);
    font-family: "Roboto", sans-serif;
    padding-right: 8px;
    background: #fff;
    width: 300px;
    position: fixed;
    height: 100vh;
    overflow-y: auto;
    transition: transform 1s ease;
    transform: translateX(${({ mobileNav }) => (mobileNav ? "0" : "-100vw")});
    z-index: 4;

    & .mobile-dull {
      opacity: 0.8;
    }

    & .calender-icon,
    .contact-icon {
      font-size: 1.55rem;
      margin-right: 15px;
    }

    & .mobile-grey {
      margin-right: 15px;
    }

    & .red-highlight {
      color: #d93025;
      background: #fceae9;
      font-weight: 500;
    }

    & .blue-highlight {
      color: #1a73e8;
      background: #d6e6fa;
      font-weight: 500;
    }
    & .green-highlight {
      color: #188038 !important;
      font-weight: 500;
      background: #d3f8de;
    }
  }
`;

export const MobileLogo = styled.p`
  color: #d93025;
  padding: 23px 10px 10px 16px;
  font-size: 20px;
  font-family: "Roboto", sans-serif;
  border-bottom: 1px solid #f1f3f4;
`;

export const NavList = styled.li`
  display: flex;
  align-items: center;
  padding: 13px 3px 13px 15px;
  border-bottom-right-radius: 25px;
  border-top-right-radius: 25px;
  color: #202124;
  border: none;
`;

export const NavListImg = styled.img`
  margin-right: 15px;
  width: 1.55rem;
`;

export const LabelText = styled.p`
  padding: 10px 0 5px 15px;
  font-size: 14px;
  font-family: "Poppins", sans-serif;
`;
export const MiddleContainer = styled.ul`
  border-bottom: 1px solid #f1f3f4;

  & .highlight {
    border-bottom-right-radius: 25px;
    border-top-right-radius: 25px;
    background-color: #e0e2e2de;
  }
`;

export const MiddleLink = styled.li`
  padding: 13px 3px 13px 15px;
  display: flex;
  align-items: center;
  color: #202124;
`;

export const MiddleLinkImg = styled.img`
  margin-right: 15px;
  width: 1.55rem;
`;

export const Number = styled.span`
  margin-left: auto;
  padding-right: 10px;
`;
