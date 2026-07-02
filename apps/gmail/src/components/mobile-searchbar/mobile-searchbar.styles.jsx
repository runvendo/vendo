import styled from "styled-components";

export const SearchbarContainer = styled.div`
  display: none;

  @media screen and (max-width: 650px) {
    display: block;
    position: relative;
    top: 2vh;
    left: 0;
    height: 50px;
    width: 100%;
    z-index: 1;
  }
`;

export const MobileSearchField = styled.div`
  @media screen and (max-width: 650px) {
    width: 90%;
    margin: auto;
    height: 100%;
    position: relative;

    .mobile-bar {
      width: 24px;
      color: #5f6368;
      position: absolute;
      top: 25%;
      left: 4%;
    }
  }
`;

export const MobileSearchInput = styled.input`
  @media screen and (max-width: 650px) {
    width: 100%;
    height: 100%;
    border-radius: 8px;
    outline: none;
    border: 1px solid #bebfc0;
    padding-left: 50px;
    font-size: 19px;
    font-family: "Roboto", sans-serif;
  }
`;

export const NameIcon = styled.div`
  @media screen and (max-width: 650px) {
    position: absolute;
    right: 3%;
    top: 24%;
    background: rgb(23, 190, 182);
    width: 27px;
    height: 27px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1rem;
    color: #fff;
    font-weight: 500;
    font-family: "Roboto", sans-serif;
  }
`;
