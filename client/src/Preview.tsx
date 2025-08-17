import { useState } from "react";
import { useStyles } from "./Preview.styles";
import { Media } from "./Media";
import { FileInfoPanel } from "./FileInfo";
import { useSelected } from "./contexts/selectedContext";

export const Preview = () => {
  const selected = useSelected();
  const styles = useStyles();
  const [showDetails, setShowDetails] = useState<Record<string, boolean>>({});

  const toggleDetails = (imagePath: string) => {
    setShowDetails(prev => ({
      ...prev,
      [imagePath]: !prev[imagePath]
    }));
  };

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
          
          {/* Info button */}
          <button 
            className={styles.infoButton}
            onClick={() => toggleDetails(image)}
            title={showDetails[image] ? "Hide details" : "Show details"}
          >
            i
          </button>
          
          {/* Details panel - only show when toggled */}
          {showDetails[image] && (
            <FileInfoPanel 
              filePath={image} 
              style={{ position: 'absolute', bottom: 0, left: 0, right: 0 }} 
            />
          )}
        </div>
      ))}
    </div>
  );
};
