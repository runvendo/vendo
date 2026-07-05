import "./App.css";
import { Route, Switch, withRouter } from "react-router-dom";
import SideBar from "./components/sidebar/sidebar.component";
import Header from "./components/searchbar/searchbar.component";
import RightColumn from "./components/right-column/right-column.component";
import Starred from "./components/starred/starred.component";
import Sent from "./components/sent/sent.component";
import MessageBox from "./components/message-box/message-box.component";
import MessageView from "./components/message-view/message-view.component";
import { useEffect, useState } from "react";
import { useDispatch } from "react-redux";
import TopLine from "./components/top-line/top-line.component";
import InboxContent from "./components/inbox-content/inbox-content.component";
import MobileNav from "./components/mobile-nav/mobile-nav.component";
import MobileSearchbar from "./components/mobile-searchbar/mobile-searchbar.component";
import ComposeBtn from "./components/composeBtn/composeBtn.component";
import ComposeMessage from "./components/composeMessage/composeMessage.component";
import VendoPage from "./vendo/VendoPage";
import { VendoLayer } from "./vendo/VendoLayer";
import { refreshMail } from "./mail-api";

function App({ location }) {
  const [messageBox, showMessageBox] = useState(true);
  const [mobileNav, showMobileNav] = useState(false);
  const dispatch = useDispatch();

  // The mailbox lives on the server; hydrate on load and keep a light poll so
  // actions the agent performs through the API show up in the UI within a beat.
  useEffect(() => {
    refreshMail(dispatch);
    const interval = setInterval(() => refreshMail(dispatch), 4000);
    const onFocus = () => refreshMail(dispatch);
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [dispatch]);

  return (
    <div className={mobileNav ? "App Hide-app" : "App"}>
      <Header />
      <SideBar shouldMessageShow={showMessageBox} />
      <RightColumn />
      <MessageBox showMessage={messageBox} shouldMessageShow={showMessageBox} />
      <MobileNav mobileNav={mobileNav} showMobileNav={showMobileNav} />

      <div className="middle">
        <div className={mobileNav ? "overlay" : "takeoff"} />
        <TopLine />
        {location.pathname !== "/compose" ? (
          <MobileSearchbar showMobileNav={showMobileNav} />
        ) : (
          ""
        )}

        <Switch>
          <Route exact path="/">
            <InboxContent />
          </Route>
          <Route path="/starred" component={Starred} />
          <Route path="/sent" component={Sent} />
          <Route path="/message/:id" component={MessageView} />
          <Route path="/vendo" component={VendoPage} />
        </Switch>
      </div>
      <Route path="/compose" component={ComposeMessage} />
      {/* The Cmd/Ctrl+K Vendo overlay, available anywhere in the app. */}
      <VendoLayer />

      {location.pathname !== "/compose" ? <ComposeBtn className="btn" /> : ""}
    </div>
  );
}

export default withRouter(App);
