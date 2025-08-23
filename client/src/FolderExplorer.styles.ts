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
        gap: "6px",
        padding: "6px 6px 4px",
        boxSizing: "border-box", 
        height: "100%",
        overflow: "hidden",
    },
    subfolderToggleBar: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '6px',
        padding: '4px 6px',
        background: '#faf9f8',
        border: '1px solid #e1dfdd',
        borderRadius: '4px',
        fontSize: '11px',
        fontWeight: 500,
        letterSpacing: '.3px'
    },
    toggleSwitch: {
        position: 'relative',
        width: '34px',
        height: '18px',
        cursor: 'pointer',
        display: 'inline-block',
        '& input': {
            opacity: 0,
            width: 0,
            height: 0,
        },
        '& span': {
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: '#c8c6c4',
            transition: '0.2s',
            borderRadius: '12px',
        },
        '& span:before': {
            position: 'absolute',
            content: '""',
            height: '14px',
            width: '14px',
            left: '2px',
            top: '2px',
            backgroundColor: 'white',
            transition: '0.2s',
            borderRadius: '50%',
            boxShadow: '0 1px 3px rgba(0,0,0,0.3)'
        },
        '& input:checked + span': {
            backgroundColor: '#0078d4'
        },
        '& input:checked + span:before': {
            transform: 'translateX(16px)'
        }
    },
    folderTreeScroll: {
        flex: 1,
        overflow: 'auto',
        paddingTop: '2px'
    }
});
