import { makeStyles } from "@fluentui/react-components";

export const useStyles = makeStyles({
  preview: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "10px",
    boxSizing: "border-box",
    overflowY: "auto",
    maxHeight: "100%",
  }
});
