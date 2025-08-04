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
    }
});
