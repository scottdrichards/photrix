import { useState } from "react";
import { useStyles } from "./Preview.styles";
import { useSelected } from "./contexts/selectedContext";
import { SmartImage } from "./media/SmartImage";
import { DashVideo, isVideo } from "./media/DashVideo";

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
      {[...selected].map((path) => (
        <div key={path} style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
          <div style={{ flex: 1, display: 'flex', height: '100%' }}>
            {isVideo(path) ?
              <DashVideo path={path}/>
              : <SmartImage
                path={path}
                style={{ objectFit: "contain", width: "100%", height: "100%" }}
                fetchPriority="high"
                loading="eager"
              />
            }
          </div>

          {/* Info button */}
          <button
            className={styles.infoButton}
            onClick={() => toggleDetails(path)}
            title={showDetails[path] ? "Hide details" : "Show details"}
          >
            i
          </button>

          {/* Details panel - only show when toggled */}
          {/* {showDetails[image] && (
            <FileInfoPanel 
              filePath={image} 
              style={{ position: 'absolute', bottom: 0, left: 0, right: 0 }} 
            />
          )} */}
        </div>
      ))}
    </div>
  );
};
