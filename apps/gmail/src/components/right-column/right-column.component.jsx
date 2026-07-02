import React from "react";
import {
  RightColumnContainer,
  ColumnItemGroup,
  ColumnListItem,
  ColumnItemImage,
  ColumnDash,
  Dash,
} from "./right-column.styles";

const RightColumn = () => {
  return (
    <RightColumnContainer>
      <ColumnItemGroup>
        <ColumnListItem>
          <span>
            <ColumnItemImage
              src="https://www.gstatic.com/companion/icon_assets/calendar_2020q4_2x.png"
              alt="icon"
            />
          </span>
        </ColumnListItem>

        <ColumnListItem>
          <span>
            <ColumnItemImage
              src="https://www.gstatic.com/companion/icon_assets/keep_2020q4v3_2x.png"
              alt="icon"
            />
          </span>
        </ColumnListItem>

        <ColumnListItem>
          <span>
            <ColumnItemImage
              src="https://www.gstatic.com/companion/icon_assets/tasks2_2x.png"
              alt="icon"
            />
          </span>
        </ColumnListItem>

        <ColumnListItem>
          <span>
            <ColumnItemImage
              src="https://www.gstatic.com/companion/icon_assets/contacts_2x.png"
              alt="icon"
            />
          </span>
        </ColumnListItem>

        <ColumnDash>
          <Dash></Dash>
        </ColumnDash>

        <ColumnListItem>
          <span>
            <ColumnItemImage
              src="https://www.gstatic.com/images/icons/material/system/1x/add_grey600_24dp.png"
              alt="icon"
            />
          </span>
        </ColumnListItem>
      </ColumnItemGroup>
    </RightColumnContainer>
  );
};

export default RightColumn;
