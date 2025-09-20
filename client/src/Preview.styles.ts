import { makeStyles } from "@fluentui/react-components";

export const useStyles = makeStyles({
  root: {
    display: "flex",
    justifyContent: "space-evenly",
    flexDirection: "column",
    gap: "10px",
    padding: "10px",
    boxSizing: "border-box",
    overflowY: "auto",
    height: "100%",
    width: "100%",
  },
  imageContainer: {
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
    flex: '1 1 auto',
    minHeight: 0
  },
  infoButton: {
    position: "absolute",
    bottom: "10px",
    right: "10px",
    width: "32px",
    height: "32px",
    borderRadius: "50%",
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    color: "white",
    border: "none",
    fontSize: "16px",
    fontWeight: "bold",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    transition: "all 0.2s ease",
    "&:hover": {
      backgroundColor: "rgba(0, 0, 0, 0.9)",
      transform: "scale(1.1)",
    },
    "&:active": {
      transform: "scale(0.95)",
    }
  }
});
