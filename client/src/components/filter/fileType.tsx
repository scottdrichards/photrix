import type { MediaTypeFilter } from "../../../../shared/filter-contract/src";

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
      <small>Type:</small>
      <button
        className={`btn btn-sm ${mediaTypeFilter === "all" ? "btn-primary" : "btn-subtle"}`}
        onClick={() => handleMediaTypeChange("all")}
      >
        All
      </button>
      <button
        className={`btn btn-sm ${mediaTypeFilter === "photo" ? "btn-primary" : "btn-subtle"}`}
        onClick={() => handleMediaTypeChange("photo")}
      >
        Photo
      </button>
      <button
        className={`btn btn-sm ${mediaTypeFilter === "video" ? "btn-primary" : "btn-subtle"}`}
        onClick={() => handleMediaTypeChange("video")}
      >
        Video
      </button>
      <button
        className={`btn btn-sm ${mediaTypeFilter === "other" ? "btn-primary" : "btn-subtle"}`}
        onClick={() => handleMediaTypeChange("other")}
      >
        Other
      </button>
    </div>
  );
};
