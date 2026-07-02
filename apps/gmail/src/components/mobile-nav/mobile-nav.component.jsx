import React, { useRef, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BiCalendarAlt } from "react-icons/bi";
import { CgProfile } from "react-icons/cg";
import { connect } from "react-redux";
import { changePage } from "../../redux/paginate/paginate.actions";
import {
  Nav,
  MobileLogo,
  NavList,
  NavListImg,
  LabelText,
  MiddleContainer,
  MiddleLink,
  MiddleLinkImg,
  Number,
} from "./mobile-nav.styles";

const MobileNav = ({ mobileNav, showMobileNav, changePage }) => {
  const [hightlight, setHighlight] = useState("primary");
  const navRef = useRef();
  // console.log(mobileNav);

  //nav action when clicked outside
  const useOnOutsideClick = (navRef, navAction) => {
    useEffect(() => {
      const navEvent = (e) => {
        if (navRef.current.contains(e.target) || !navRef.current) {
          return;
        }

        navAction(e);
      };

      document.addEventListener("mousedown", navEvent);
      document.addEventListener("touchstart", navEvent);

      return () => {
        document.removeEventListener("mousedown", navEvent);
        document.removeEventListener("touchstart", navEvent);
      };
    }, [navAction, navRef]);
  };

  useOnOutsideClick(navRef, () => showMobileNav(false));

  return (
    <Nav ref={navRef} mobileNav={mobileNav}>
      <MobileLogo>Gmail</MobileLogo>
      <ul className="mobile-nav-button">
        <Link to="/">
          <NavList
            className={hightlight === "primary" ? "red-highlight" : ""}
            onClick={() => {
              changePage(1);
              setHighlight("primary");
              showMobileNav(false);
            }}
          >
            {hightlight === "primary" ? (
              <NavListImg
                src="https://www.gstatic.com/images/icons/material/system/1x/inbox_gm_googlered600_20dp.png"
                alt="NavListImg"
              />
            ) : (
              <NavListImg
                src="https://www.gstatic.com/images/icons/material/system/1x/inbox_black_20dp.png"
                alt="inbox"
                className="mobile-dull"
              />
            )}

            <span>Primary</span>
          </NavList>
        </Link>
        <Link to="/">
          <NavList
            className={hightlight === "social" ? "blue-highlight" : ""}
            onClick={() => {
              changePage(2);
              setHighlight("social");
              showMobileNav(false);
            }}
          >
            {hightlight === "social" ? (
              <NavListImg
                src="https://www.gstatic.com/images/icons/material/system/1x/people_gm_blue600_20dp.png"
                alt="NavListImg"
              />
            ) : (
              <NavListImg
                src="https://www.gstatic.com/images/icons/material/system/1x/people_black_20dp.png"
                alt="NavListImg"
                className="mobile-dull"
              />
            )}
            <span>Social</span>
          </NavList>
        </Link>
        <NavList
          className={hightlight === "promotion" ? "green-highlight" : ""}
          onClick={() => {
            changePage(3);
            setHighlight("promotion");
            showMobileNav(false);
          }}
        >
          {hightlight === "promotion" ? (
            <NavListImg
              src="https://www.gstatic.com/images/icons/material/system/1x/local_offer_gm_green700_20dp.png"
              alt="NavListImg"
            />
          ) : (
            <NavListImg
              src="https://www.gstatic.com/images/icons/material/system/1x/local_offer_black_20dp.png"
              alt="NavListImg"
              className="mobile-dull"
            />
          )}

          <span>Promotions</span>
        </NavList>
      </ul>
      <div className="mobile-options-list">
        <LabelText>ALL LABELS</LabelText>
        <MiddleContainer>
          <Link to="/starred">
            <MiddleLink
              className={hightlight === "starred" ? "highlight" : ""}
              onClick={() => {
                setHighlight("starred");
                showMobileNav(false);
              }}
            >
              <span className="icon">
                <MiddleLinkImg
                  src="https://www.gstatic.com/images/icons/material/system/1x/grade_black_20dp.png"
                  alt="inbox"
                  className="mobile-dull"
                />
              </span>
              <span className="title">Starred</span>
            </MiddleLink>
          </Link>

          <MiddleLink
            className={hightlight === "snoozed" ? "highlight" : ""}
            onClick={() => setHighlight("snoozed")}
          >
            <span className="icon">
              <MiddleLinkImg
                src="https://www.gstatic.com/images/icons/material/system/1x/watch_later_black_20dp.png"
                alt="inbox"
                className="mobile-dull"
              />
            </span>
            <span className="title">Snoozed</span>
          </MiddleLink>

          <MiddleLink
            className={hightlight === "important" ? "highlight" : ""}
            onClick={() => setHighlight("important")}
          >
            <span className="icon">
              <MiddleLinkImg
                src="https://www.gstatic.com/images/icons/material/system/1x/label_important_black_20dp.png"
                alt="inbox"
                className="mobile-dull"
              />
            </span>
            <span className="title">Important</span>
          </MiddleLink>

          <Link to="/sent">
            <MiddleLink
              className={hightlight === "sent" ? "highlight" : ""}
              onClick={() => {
                setHighlight("sent");
                showMobileNav(false);
              }}
            >
              <span className="icon">
                <MiddleLinkImg
                  src="https://www.gstatic.com/images/icons/material/system/1x/send_black_20dp.png"
                  alt="inbox"
                  className="mobile-dull"
                />
              </span>
              <span className="title">Sent</span>
            </MiddleLink>
          </Link>

          <MiddleLink
            className={hightlight === "scheduled" ? "highlight" : ""}
            onClick={() => setHighlight("scheduled")}
          >
            <span className="icon">
              <MiddleLinkImg
                src="https://www.gstatic.com/images/icons/material/system/1x/schedule_send_black_20dp.png"
                alt="inbox"
                className="mobile-dull"
              />
            </span>
            <span className="title">Scheduled</span>
          </MiddleLink>

          <MiddleLink
            className={hightlight === "drafts" ? "highlight" : ""}
            onClick={() => setHighlight("drafts")}
          >
            <span className="icon">
              <MiddleLinkImg
                src="https://www.gstatic.com/images/icons/material/system/1x/insert_drive_file_black_20dp.png"
                alt="inbox"
                className="mobile-dull"
              />
            </span>
            <span className="title">Drafts</span>
            <Number>20</Number>
          </MiddleLink>

          <MiddleLink
            className={hightlight === "chats" ? "highlight" : ""}
            onClick={() => setHighlight("chats")}
          >
            <span className="icon">
              <MiddleLinkImg
                src="https://www.gstatic.com/images/icons/material/system/1x/hangout_black_20dp.png"
                alt="inbox"
                className="mobile-dull"
              />
            </span>
            <span className="title">Chats</span>
          </MiddleLink>

          <MiddleLink
            className={hightlight === "all-mail" ? "highlight" : ""}
            onClick={() => setHighlight("all-mail")}
          >
            <span className="icon">
              <MiddleLinkImg
                src="https://www.gstatic.com/images/icons/material/system/1x/mail_black_20dp.png"
                alt="inbox"
                className="mobile-dull"
              />
            </span>
            <span className="title">All Mail</span>
          </MiddleLink>

          <MiddleLink
            className={hightlight === "spam" ? "highlight" : ""}
            onClick={() => setHighlight("spam")}
          >
            <span className="icon">
              <MiddleLinkImg
                src="https://www.gstatic.com/images/icons/material/system/1x/report_black_20dp.png"
                alt="inbox"
                className="mobile-dull"
              />
            </span>
            <span className="title">Spam</span>
            <Number>2</Number>
          </MiddleLink>

          <MiddleLink
            className={hightlight === "trash" ? "highlight" : ""}
            onClick={() => setHighlight("trash")}
          >
            <span className="icon">
              <MiddleLinkImg
                src="https://www.gstatic.com/images/icons/material/system/1x/delete_black_20dp.png"
                alt="inbox"
                className="mobile-dull"
              />
            </span>
            <span className="title">Trash</span>
          </MiddleLink>

          <MiddleLink>GOOGLE APPS</MiddleLink>
          <MiddleLink>
            <BiCalendarAlt className="calender-icon" />
            <span className="title">Calendar</span>
          </MiddleLink>
          <MiddleLink>
            <CgProfile className="contact-icon" />
            <span className="title">Contacts</span>
          </MiddleLink>
        </MiddleContainer>

        <ul className="mobile-options-bottom">
          <MiddleLink>
            <span>
              <svg
                className="Xy mobile-grey"
                xmlns="http://www.w3.org/2000/svg"
                width="24"
                height="24"
                viewBox="0 0 24 24"
              >
                <path d="M13.85 22.25h-3.7c-.74 0-1.36-.54-1.45-1.27l-.27-1.89c-.27-.14-.53-.29-.79-.46l-1.8.72c-.7.26-1.47-.03-1.81-.65L2.2 15.53c-.35-.66-.2-1.44.36-1.88l1.53-1.19c-.01-.15-.02-.3-.02-.46 0-.15.01-.31.02-.46l-1.52-1.19c-.59-.45-.74-1.26-.37-1.88l1.85-3.19c.34-.62 1.11-.9 1.79-.63l1.81.73c.26-.17.52-.32.78-.46l.27-1.91c.09-.7.71-1.25 1.44-1.25h3.7c.74 0 1.36.54 1.45 1.27l.27 1.89c.27.14.53.29.79.46l1.8-.72c.71-.26 1.48.03 1.82.65l1.84 3.18c.36.66.2 1.44-.36 1.88l-1.52 1.19c.01.15.02.3.02.46s-.01.31-.02.46l1.52 1.19c.56.45.72 1.23.37 1.86l-1.86 3.22c-.34.62-1.11.9-1.8.63l-1.8-.72c-.26.17-.52.32-.78.46l-.27 1.91c-.1.68-.72 1.22-1.46 1.22zm-3.23-2h2.76l.37-2.55.53-.22c.44-.18.88-.44 1.34-.78l.45-.34 2.38.96 1.38-2.4-2.03-1.58.07-.56c.03-.26.06-.51.06-.78s-.03-.53-.06-.78l-.07-.56 2.03-1.58-1.39-2.4-2.39.96-.45-.35c-.42-.32-.87-.58-1.33-.77l-.52-.22-.37-2.55h-2.76l-.37 2.55-.53.21c-.44.19-.88.44-1.34.79l-.45.33-2.38-.95-1.39 2.39 2.03 1.58-.07.56a7 7 0 0 0-.06.79c0 .26.02.53.06.78l.07.56-2.03 1.58 1.38 2.4 2.39-.96.45.35c.43.33.86.58 1.33.77l.53.22.38 2.55z"></path>
                <circle cx="12" cy="12" r="3.5"></circle>
              </svg>
            </span>
            <span>Settings</span>
          </MiddleLink>
          <MiddleLink>
            <span>
              <svg
                className="t7 mobile-grey"
                xmlns="http://www.w3.org/2000/svg"
                width="24px"
                height="24px"
                viewBox="0 0 24 24"
                fill="#000000"
                focusable="false"
              >
                <path fill="none" d="M0 0h24v24H0z"></path>
                <path d="M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z"></path>
              </svg>
            </span>
            <span>Help & feedback</span>
          </MiddleLink>
        </ul>
      </div>
    </Nav>
  );
};

const mapDispatchToProps = (dispatch) => ({
  changePage: (value) => dispatch(changePage(value)),
});
export default connect(null, mapDispatchToProps)(MobileNav);
