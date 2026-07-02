import styled from "styled-components";

export const MobileComposeBtn = styled.button`
  display: none;

  @media screen and (max-width: 650px) {
    position: fixed;
    display: flex;
    align-items: center;
    background: #fff;
    right: 18px;
    bottom: 18px;
    border-radius: 50%;
    outline: none;
    border: none;
    box-shadow: 0px 0px 10px rgba(0, 0, 0, 0.4);
    padding: 10px;
    z-index: 2;
    transition: 1s all ease;
  }
`;
