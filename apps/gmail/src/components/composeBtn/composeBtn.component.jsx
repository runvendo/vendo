import React from "react";
import { Link } from "react-router-dom";
import { MobileComposeBtn } from "./composeBtn.styles";

const ComposeBtn = () => {
  return (
    <Link to="/compose">
      <MobileComposeBtn>
        <img
          src="https://www.gstatic.com/images/icons/material/colored_icons/1x/create_32dp.png"
          alt="imageBtn"
        />
      </MobileComposeBtn>
    </Link>
  );
};

export default ComposeBtn;
