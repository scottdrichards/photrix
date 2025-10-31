import { useState } from "react";
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Button,
  Label,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { ChevronDown24Regular, Dismiss24Regular } from "@fluentui/react-icons";
import type { FilterState } from "../../types/filters";
import { StarRatingFilter } from "./StarRatingFilter";
import { TagFilter } from "./TagFilter";
import { DateRangeFilter } from "./DateRangeFilter";
import { CameraFilter } from "./CameraFilter";
import { FolderBrowser } from "./FolderBrowser";
import { MapFilter } from "./MapFilter";

const useStyles = makeStyles({
  container: {
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalL,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: tokens.spacingVerticalM,
  },
  filterSection: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
  },
  accordionItem: {
    backgroundColor: tokens.colorNeutralBackground1,
  },
});

export type FilterPanelProps = {
  filters: FilterState;
  onChange: (filters: FilterState) => void;
  onClear: () => void;
};

export const FilterPanel = ({ filters, onChange, onClear }: FilterPanelProps) => {
  const styles = useStyles();
  const [openItems, setOpenItems] = useState<string[]>(["folders", "ratings"]);

  const hasActiveFilters =
    (filters.directories && filters.directories.length > 0) ||
    filters.minRating !== undefined ||
    (filters.tags && filters.tags.length > 0) ||
    filters.dateRange !== undefined ||
    filters.location !== undefined ||
    (filters.cameraMake && filters.cameraMake.length > 0) ||
    (filters.cameraModel && filters.cameraModel.length > 0);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <Label size="large" weight="semibold">
          Filters
        </Label>
        {hasActiveFilters && (
          <Button
            appearance="subtle"
            icon={<Dismiss24Regular />}
            onClick={onClear}
          >
            Clear All
          </Button>
        )}
      </div>

      <Accordion
        multiple
        openItems={openItems}
        onToggle={(_, data) => setOpenItems(data.openItems as string[])}
        collapsible
      >
        <AccordionItem value="folders" className={styles.accordionItem}>
          <AccordionHeader icon={<ChevronDown24Regular />}>
            Folders
          </AccordionHeader>
          <AccordionPanel>
            <div className={styles.filterSection}>
              <FolderBrowser
                value={filters.directories ?? []}
                onChange={(directories) =>
                  onChange({
                    ...filters,
                    directories: directories.length > 0 ? directories : undefined,
                  })
                }
              />
            </div>
          </AccordionPanel>
        </AccordionItem>

        <AccordionItem value="ratings" className={styles.accordionItem}>
          <AccordionHeader icon={<ChevronDown24Regular />}>
            Star Rating
          </AccordionHeader>
          <AccordionPanel>
            <div className={styles.filterSection}>
              <Label>Minimum rating</Label>
              <StarRatingFilter
                value={filters.minRating}
                onChange={(minRating) => onChange({ ...filters, minRating })}
              />
            </div>
          </AccordionPanel>
        </AccordionItem>

        <AccordionItem value="tags" className={styles.accordionItem}>
          <AccordionHeader icon={<ChevronDown24Regular />}>
            Keywords/Tags
          </AccordionHeader>
          <AccordionPanel>
            <div className={styles.filterSection}>
              <TagFilter
                value={filters.tags ?? []}
                onChange={(tags) =>
                  onChange({ ...filters, tags: tags.length > 0 ? tags : undefined })
                }
              />
            </div>
          </AccordionPanel>
        </AccordionItem>

        <AccordionItem value="dateRange" className={styles.accordionItem}>
          <AccordionHeader icon={<ChevronDown24Regular />}>
            Date Range
          </AccordionHeader>
          <AccordionPanel>
            <div className={styles.filterSection}>
              <DateRangeFilter
                value={filters.dateRange}
                onChange={(dateRange) => onChange({ ...filters, dateRange })}
              />
            </div>
          </AccordionPanel>
        </AccordionItem>

        <AccordionItem value="map" className={styles.accordionItem}>
          <AccordionHeader icon={<ChevronDown24Regular />}>
            Location (Map)
          </AccordionHeader>
          <AccordionPanel>
            <div className={styles.filterSection}>
              <Label>Move the map to filter by location</Label>
              <MapFilter
                value={filters.location}
                onChange={(location) => onChange({ ...filters, location })}
              />
            </div>
          </AccordionPanel>
        </AccordionItem>

        <AccordionItem value="camera" className={styles.accordionItem}>
          <AccordionHeader icon={<ChevronDown24Regular />}>
            Camera Make/Model
          </AccordionHeader>
          <AccordionPanel>
            <div className={styles.filterSection}>
              <CameraFilter
                makes={filters.cameraMake ?? []}
                models={filters.cameraModel ?? []}
                onMakesChange={(cameraMake) =>
                  onChange({
                    ...filters,
                    cameraMake: cameraMake.length > 0 ? cameraMake : undefined,
                  })
                }
                onModelsChange={(cameraModel) =>
                  onChange({
                    ...filters,
                    cameraModel: cameraModel.length > 0 ? cameraModel : undefined,
                  })
                }
              />
            </div>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
    </div>
  );
};
