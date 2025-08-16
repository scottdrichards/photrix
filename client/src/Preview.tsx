import { useStyles } from "./Preview.styles";
import { Media } from "./Media";
import { FileInfoPanel } from "./FileInfo";
import { useSelected } from "./contexts/selectedContext";

export const Preview = () => {
  const selected = useSelected();
  const styles = useStyles();

  return (
    <div className={styles.preview}>
      {[...selected].map((image) => (
        <div key={image} style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
          <div style={{ flex: 1, display: 'flex', height: '100%' }}>
            <Media
              path={image}
              style={{ objectFit: "contain", width: "100%", height: "100%" }}
              thumbnailBehavior={{ fetchPriority: "high", loading: "eager" }}
              fullSizeBehavior={{ fetchPriority: "high", loading: "eager" }}
            />
          </div>
          <FileInfoPanel filePath={image} style={{ position: 'absolute', bottom: 0, left: 0, right: 0 }} />
        </div>
      ))}
    </div>
  );
};
