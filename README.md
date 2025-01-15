# photrix

# UI
```
+-------------+-------------------------+------------+
|  Filter Pane|  Thumbnail Window       | Details    |
|             |                         |            |
|             |                         |            |
|             |                         |            |
|             |                         |            |
|             |------------------------ |------------|
|             | Preview Window          | Actions    |
|             |                         |            |
|             |                         |            |
|             |                         |            |
|             |                         |            |
+-------------+-------------------------+------------+
```
## Filter Pane 

Filter sections: 
- Folder (tree view) 
- Text search (filename, keywords, tags, etc.) 
- Tags/Keywords 
- Date Taken 
- EXIF 

Filter Operation 
- Sections are AND
- By default, section will only show items that are relevant given other filters that are applied. This can be changed to show all options – even those that will not reveal any more files. 

    - Changing a filter in a filter section will update filter options in other sections 

Actions 

UseAction: 

Updates Global Filter 

When global filter is changed: 

For each filter section, make requests to see what filter section options would be - give all other filter section states 

Thumbnail Pane 

Shows a grid of thumbnails 

Grid size is set by zoom level. Grid is irrespective of number of items (even if just one image, respect grid zoom level). 

Actions 

OnGlobalFilterChanged 

Update grid – ask photo service for N photos that would fit in max grid size. Gets a list of images, requests images. 

OnSelect 

Set a global "selected" variable with a list of paths for the images 

Preview Pane 

Shows the selected image(s) 

Actions 

Click to zoom in/out 

No data-out 