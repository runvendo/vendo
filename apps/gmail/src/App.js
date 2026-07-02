import "./App.css";
import { Route, Switch, withRouter } from "react-router-dom";
import SideBar from "./components/sidebar/sidebar.component";
import Header from "./components/searchbar/searchbar.component";
import RightColumn from "./components/right-column/right-column.component";
import Starred from "./components/starred/starred.component";
import Sent from "./components/sent/sent.component";
import MessageBox from "./components/message-box/message-box.component";
import { useState } from "react";
import TopLine from "./components/top-line/top-line.component";
import InboxContent from "./components/inbox-content/inbox-content.component";
import MobileNav from "./components/mobile-nav/mobile-nav.component";
import MobileSearchbar from "./components/mobile-searchbar/mobile-searchbar.component";
import ComposeBtn from "./components/composeBtn/composeBtn.component";
import ComposeMessage from "./components/composeMessage/composeMessage.component";

function App({ location }) {
  const [messageBox, showMessageBox] = useState(true);
  const [mobileNav, showMobileNav] = useState(false);

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
        </Switch>
      </div>
      <Route path="/compose" component={ComposeMessage} />

      {location.pathname !== "/compose" ? <ComposeBtn className="btn" /> : ""}
    </div>
  );
}

export default withRouter(App);
