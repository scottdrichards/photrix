import { makeStyles } from "@fluentui/react-components";

export const useStyles = makeStyles({
  root:{
    display: "grid",
    gridTemplateRows: "100%",
    height: "100%",
    width: "100%",
    boxSizing: "border-box",
    fontFamily: "'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif",
    overflow: "hidden",
    // Columns will be injected inline via style prop using stateful widths
  },
  panelWrapper: {
    minWidth: 0,
  minHeight: 0,
  height: "100%",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column"
  },
  divider: {
    width: "6px",
    cursor: "col-resize",
    background: "linear-gradient(#f3f2f1,#e1dfdd)",
    position: "relative",
    transition: "background 0.15s ease",
    '&:after': {
      content: '""',
      position: 'absolute',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: '2px',
      height: '28px',
      background: '#c8c6c4',
      borderRadius: '2px'
    },
    '&:hover': {
      background: "linear-gradient(#ecebea,#dadada)"
    }
  },
  dragging: {
    background: "#ffe8b5 !important"
  }
});
