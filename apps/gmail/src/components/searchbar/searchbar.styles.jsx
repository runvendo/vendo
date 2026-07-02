import styled from "styled-components";

export const SearchHeader = styled.div`
  width: 100vw;
  display: flex;
  padding: 7px 20px;
  border-bottom: 1px solid #f1f3f4;
  font-family: "Poppins", sans-serif;
  position: fixed;
  z-index: 3;
  background: #fff;

  @media (max-width: 650px) {
    display: none;
  }
`;

export const Logo = styled.div`
  display: flex;
  width: 240px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-right: 90px;

  & .bar {
    width: 24px;
    color: #5f6368;
  }
`;

export const Search = styled.div`
  position: relative;
  margin-right: auto;
  width: 720px;

  @media screen and (max-width: 1200px) {
    width: 55%;
  }

  @media screen and (max-width: 900px) {
    width: 48%;
  }
`;

export const HeaderSearchInput = styled.input`
  width: 100%;
  padding-left: 60px;
  height: 48px;
  background: #f1f3f4;
  border-radius: 9px;
  border: none;
  outline: none;
  font-size: 0.9rem;
`;

export const HeaderSearchIcon = styled.span`
  color: #5f6368;
  position: absolute;
  top: 11px;
  left: 20px;
`;

export const HeaderArrowIcon = styled.span`
  color: #5f6368;
  position: absolute;
  right: 30px;
  top: 10px;
`;

export const HeaderRightIcons = styled.div`
  display: flex;
  align-items: center;
  width: 170px;
  justify-content: space-between;
  padding-left: 20px;

  & .grey {
    opacity: 0.64;

    &:hover {
      cursor: pointer;
      background: #ddd;
      border-radius: 50%;
    }
  }

  & .gb_Xe {
    width: 24px;
  }

  @media screen and (max-width: 900px) {
    width: 185px;
  }
`;

export const PersonIcon = styled.span`
  background: rgb(23, 190, 182);
  width: 27px;
  height: 27px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 1rem;
  margin-bottom: 5px;
`;
