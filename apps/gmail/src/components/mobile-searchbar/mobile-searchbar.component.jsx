import React from "react";

import {
  SearchbarContainer,
  MobileSearchField,
  MobileSearchInput,
  NameIcon,
} from "./mobile-searchbar.styles";

const MobileSearchbar = ({ showMobileNav }) => {
  return (
    <SearchbarContainer>
      <MobileSearchField>
        <MobileSearchInput
          type="text"
          name="input"
          placeholder="Search Gmail"
        />
        <svg
          onClick={() => showMobileNav(true)}
          className="mobile-bar"
          focusable="false"
          viewBox="0 0 24 24"
        >
          <path
            className="bar-line"
            d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"
          ></path>
        </svg>
        <NameIcon>T</NameIcon>
      </MobileSearchField>
    </SearchbarContainer>
  );
};

export default MobileSearchbar;
