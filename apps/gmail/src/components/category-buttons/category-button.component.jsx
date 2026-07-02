import React, { useState } from "react";
import {
  changePage,
  hidePromo,
  hideSocial,
} from "../../redux/paginate/paginate.actions";
import {
  selectPromo,
  selectSocial,
} from "../../redux/paginate/paginate.selectors";
import { connect } from "react-redux";
import { createStructuredSelector } from "reselect";
import {
  BottomBorder1,
  BottomBorder2,
  BottomBorder3,
  CategoryButtonContainer,
  CategoryButton1,
  CategoryButton2,
  CategoryButton3,
  ButtonImageContainer,
  ButtonInfo,
  ButtonInfoTop,
  ButtonInfoBottom,
  ButtonInfoTitle,
} from "./category-buttons.styles";

const CategoryBtn = ({
  changePage,
  hidePromo,
  hideSocial,
  selectPromo,
  selectSocial,
}) => {
  const [color, setColor] = useState("red");

  const handleChange1 = () => {
    setColor("red");
    changePage(1);
  };

  const handleChange2 = () => {
    setColor("blue");
    changePage(2);
    hideSocial();
  };

  const handleChange3 = () => {
    setColor("green");
    changePage(3);
    hidePromo();
  };

  return (
    <CategoryButtonContainer>
      <CategoryButton1 color={color} onClick={handleChange1}>
        <ButtonImageContainer>
          {color === "red" ? (
            <img
              src="https://www.gstatic.com/images/icons/material/system/1x/inbox_gm_googlered600_20dp.png"
              alt="img"
            />
          ) : (
            <img
              src="https://www.gstatic.com/images/icons/material/system/1x/inbox_black_20dp.png"
              alt="img"
              className="dull"
            />
          )}
        </ButtonImageContainer>
        <p>Primary</p>
        <BottomBorder1 color={color}></BottomBorder1>
      </CategoryButton1>
      <CategoryButton2 color={color} onClick={handleChange2}>
        <ButtonImageContainer>
          {color === "blue" ? (
            <img
              src="https://www.gstatic.com/images/icons/material/system/1x/people_gm_blue600_20dp.png"
              alt="img"
            />
          ) : (
            <img
              src="https://www.gstatic.com/images/icons/material/system/1x/people_black_20dp.png"
              alt="img"
              className="dull"
            />
          )}
        </ButtonImageContainer>

        <ButtonInfo>
          <ButtonInfoTop>
            <p>Social</p>
            <ButtonInfoTitle
              className={selectSocial ? "new-social" : "new-social disappear"}
            >
              2 new
            </ButtonInfoTitle>
          </ButtonInfoTop>
          <ButtonInfoBottom
            className={selectSocial ? "new-social" : "new-social disappear"}
          >
            Twitter, LinkedIn
          </ButtonInfoBottom>
        </ButtonInfo>
        <BottomBorder2 color={color}></BottomBorder2>
      </CategoryButton2>
      <CategoryButton3 color={color} onClick={handleChange3}>
        <ButtonImageContainer>
          {color === "green" ? (
            <img
              src="https://www.gstatic.com/images/icons/material/system/1x/local_offer_gm_green700_20dp.png"
              alt="img"
            />
          ) : (
            <img
              src="https://www.gstatic.com/images/icons/material/system/1x/local_offer_black_20dp.png"
              alt="img"
              className="dull"
            />
          )}
        </ButtonImageContainer>
        <ButtonInfo>
          <ButtonInfoTop>
            <p className={selectPromo ? "promotion-title" : ""}>Promotions</p>
            <ButtonInfoTitle
              className={selectPromo ? "new-promo" : "clear new-promo"}
            >
              1 new
            </ButtonInfoTitle>
          </ButtonInfoTop>
          <ButtonInfoBottom
            className={selectPromo ? "new-promo" : "new-promo clear"}
          >
            Udemy
          </ButtonInfoBottom>
        </ButtonInfo>
        <BottomBorder3 color={color}></BottomBorder3>
      </CategoryButton3>
    </CategoryButtonContainer>
  );
};

const mapStateToProps = createStructuredSelector({
  selectSocial,
  selectPromo,
});
const mapDispatchToProps = (dispatch) => ({
  changePage: (value) => dispatch(changePage(value)),
  hideSocial: () => dispatch(hideSocial()),
  hidePromo: () => dispatch(hidePromo()),
});

export default connect(mapStateToProps, mapDispatchToProps)(CategoryBtn);
