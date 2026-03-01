export const FileTypeFilter = ()=>{
    return         <div>
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
}