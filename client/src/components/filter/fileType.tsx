import { Button, Caption1 } from "@fluentui/react-components";
import type { MediaTypeFilter } from "./FilterContext";

type FileTypeFilterProps = {
  mediaTypeFilter: MediaTypeFilter;
  handleMediaTypeChange: (type: MediaTypeFilter) => void;
};

export const FileTypeFilter = ({
  mediaTypeFilter,
  handleMediaTypeChange,
}: FileTypeFilterProps) => {
  return (
    <div>
      <Caption1>Type:</Caption1>
      <Button
        size="small"
        appearance={mediaTypeFilter === "all" ? "primary" : "subtle"}
        onClick={() => handleMediaTypeChange("all")}
      >
        All
      </Button>
      <Button
        size="small"
        appearance={mediaTypeFilter === "photo" ? "primary" : "subtle"}
        onClick={() => handleMediaTypeChange("photo")}
      >
        Photo
      </Button>
      <Button
        size="small"
        appearance={mediaTypeFilter === "video" ? "primary" : "subtle"}
        onClick={() => handleMediaTypeChange("video")}
      >
        Video
      </Button>
      <Button
        size="small"
        appearance={mediaTypeFilter === "other" ? "primary" : "subtle"}
        onClick={() => handleMediaTypeChange("other")}
      >
        Other
      </Button>
    </div>
  );
};
