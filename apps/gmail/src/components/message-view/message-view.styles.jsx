import styled from "styled-components";

export const ViewContainer = styled.div`
  background: #ffffff;
  min-height: 60vh;
  padding: 0 16px 40px;
  /* The TopLine above is position: fixed — clear it like InboxContainer does. */
  margin-top: 48px;

  @media (max-width: 650px) {
    margin-top: 20px;
  }
`;

export const ViewToolbar = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 0;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);

  .view-icon {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: #5f6368;
    font-size: 16px;

    &:hover {
      background: rgba(32, 33, 36, 0.06);
    }
  }
`;

export const ViewSubjectRow = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px 36px 8px;

  h2 {
    font-size: 1.375rem;
    font-weight: 400;
    color: #202124;
    font-family: "Google Sans", Roboto, sans-serif;
  }
`;

export const FolderChip = styled.span`
  font-size: 0.75rem;
  color: #5f6368;
  background: rgba(32, 33, 36, 0.08);
  border-radius: 4px;
  padding: 2px 8px;
  white-space: nowrap;
`;

export const SenderRow = styled.div`
  display: flex;
  align-items: center;
  padding: 12px 36px 4px 20px;
  gap: 12px;
`;

export const Avatar = styled.div`
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: ${({ hue }) => `hsl(${hue}, 45%, 45%)`};
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.1rem;
  font-family: "Google Sans", Roboto, sans-serif;
  flex-shrink: 0;
`;

export const SenderMeta = styled.div`
  flex: 1;
  min-width: 0;

  .sender-line {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
  }

  .sender-name {
    font-size: 0.875rem;
    font-weight: 600;
    color: #202124;
  }

  .sender-email {
    font-size: 0.75rem;
    color: #5f6368;
  }

  .to-line {
    font-size: 0.75rem;
    color: #5f6368;
  }
`;

export const ViewDate = styled.div`
  font-size: 0.75rem;
  color: #5f6368;
  white-space: nowrap;
  padding-right: 8px;
`;

export const ViewBody = styled.div`
  padding: 20px 36px 24px 72px;
  font-size: 0.875rem;
  color: #202124;
  line-height: 1.6;
  white-space: pre-line;
  max-width: 900px;
`;

export const NotFound = styled.div`
  padding: 60px;
  text-align: center;
  color: #5f6368;
`;
