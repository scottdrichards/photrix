import { makeStyles } from "@fluentui/react-components";

export const useStyles = makeStyles({
  root:{
    display: "grid",
    gridTemplateColumns: "fit-content(20%) 1fr minmax(0, 1fr)",
    boxSizing: "border-box",
    gridTemplateRows: "100%",
    height: "100%",
    width: "100%",
  },
  folderSelectionPanel:{
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "10px",
    boxSizing: "border-box", 
    height: "100%",
    overflow: "auto",
  },
  preview:{
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "10px",
    boxSizing: "border-box",
    overflowY: "auto",
    maxHeight: "100%",
  }
})
