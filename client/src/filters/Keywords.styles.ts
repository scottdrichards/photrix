import { makeStyles } from "@fluentui/react-components";

export const useStyles = makeStyles({
  keywordsContainer: {
    display: "flex",
    flexDirection: "column",
  gap: "4px",
  marginBottom: "8px"
  },
  searchSection: {
    display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: "4px",
  padding: "4px 6px",
  backgroundColor: "#faf9f8",
  borderRadius: "6px",
  border: "1px solid #e1dfdd"
  },
  clearButton: {
    cursor: 'pointer',
    border: 'none',
    background: 'transparent',
    padding: '0 4px',
    fontSize: '12px',
    lineHeight: 1,
    color: '#605e5c',
    borderRadius: '3px',
    transition: 'background 0.15s ease, color 0.15s ease',
    '&:hover': {
      background: '#edebe9',
      color: '#323130'
    },
    '&:active': {
      background: '#e1dfdd'
    },
    '&[disabled]': {
      opacity: 0.3,
      cursor: 'default'
    }
  },
  searchLabel: {
  display: "none"
  },
  searchInput: {
    borderRadius: "4px",
    transition: "all 0.15s ease",
    flexGrow: 1,
    minWidth: 0,
    fontSize: "11px",
    height: "24px",
    padding: 0,
    // Smaller placeholder
    '::placeholder': {
      fontSize: "10px",
      color: '#8a8886'
    }
  },
  keywordsList: {
    display: "flex",
    flexWrap: "wrap",
  gap: "4px",
  padding: "2px 0 0"
  },
  keywordsHeader: {
  fontSize: "11px",
  fontWeight: 500,
  color: "#605e5c",
  margin: "2px 0 0",
  textTransform: "uppercase",
  letterSpacing: "0.5px"
  }
});
