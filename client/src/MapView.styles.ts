import { makeStyles } from "@fluentui/react-components";

export const useStyles = makeStyles({
  mapContainer: {
    width: "100%",
  height: "100%", // Fill parent panel height
    position: "relative"
  },
  mapWrapper: {
    width: "100%",
    height: "100%"
  },
  imageMarker: {
    width: "100px",
    height: "100px",
    borderRadius: "8px",
    border: "3px solid white",
    boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
    cursor: "pointer",
    transition: "transform 0.2s ease",
    "&:hover": {
      transform: "scale(1.1)",
      zIndex: 1000
    }
  },
  clusterMarker: {
    width: "40px",
    height: "40px",
    borderRadius: "50%",
    backgroundColor: "#0078d4",
    color: "white",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: "bold",
    fontSize: "14px",
    border: "3px solid white",
    boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
    cursor: "pointer",
    transition: "transform 0.2s ease",
    "&:hover": {
      transform: "scale(1.2)",
      backgroundColor: "#106ebe"
    }
  },
  loadingSpinner: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    fontSize: "16px",
    color: "#605e5c"
  }
});
