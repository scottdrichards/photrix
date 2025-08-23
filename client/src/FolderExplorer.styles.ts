import { makeStyles } from "@fluentui/react-components";

export const useStyles = makeStyles({
  folder: {
        paddingLeft: "20px",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        fontWeight: "bold",
    },
    folderHeader:{
        ":hover": {
            backgroundColor: "lightgray",
        },
        "&[data-selected]": {
            backgroundColor: "lightblue",
        },
    },
    folderSelectionPanel: {
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        padding: "10px",
        boxSizing: "border-box", 
        height: "100%",
        overflow: "auto",
    }
});
