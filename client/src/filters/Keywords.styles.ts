import { makeStyles } from "@fluentui/react-components";

export const useStyles = makeStyles({
  keywordsContainer: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    marginBottom: "16px"
  },
  searchSection: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "12px",
    backgroundColor: "#faf9f8",
    borderRadius: "8px",
    border: "1px solid #e1dfdd"
  },
  searchLabel: {
    fontSize: "14px",
    fontWeight: "600",
    color: "#323130",
    marginBottom: "4px"
  },
  searchInput: {
    borderRadius: "6px",
    transition: "all 0.2s ease"
  },
  keywordsList: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    padding: "8px 0"
  },
  keywordsHeader: {
    fontSize: "13px",
    fontWeight: "500",
    color: "#605e5c",
    marginBottom: "8px",
    textTransform: "uppercase",
    letterSpacing: "0.5px"
  }
});
