import { makeStyles } from "@fluentui/react-components";

export const useStyles = makeStyles({
  root:{
    display: "grid",
    gridTemplateColumns: "fit-content(20%) minmax(0, 1fr) minmax(0, 1fr)",
    boxSizing: "border-box",
    gridTemplateRows: "100%",
    height: "100%",
    width: "100%",

    fontFamily: "'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif",
  }
})
