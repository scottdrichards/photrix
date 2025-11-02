import {
  Button,
  Label,
  makeStyles,
  tokens,
  Card,
} from "@fluentui/react-components";
import { Dismiss24Regular } from "@fluentui/react-icons";
import type { FilterState } from "../../types/filters";
import { StarRatingFilter } from "./StarRatingFilter";
import { TagFilter } from "./TagFilter";
import { DateSliderFilter } from "./DateSliderFilter";
import { CameraFilter } from "./CameraFilter";
import { FolderTreeFilter } from "./FolderTreeFilter";
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
  filtersGrid: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalM,
  },
  filterCard: {
    flex: "1 1 300px",
    minWidth: "300px",
    padding: tokens.spacingVerticalM,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  filterTitle: {
    fontWeight: tokens.fontWeightSemibold,
    marginBottom: tokens.spacingVerticalXS,
  },
});

export type FilterPanelProps = {
  filters: FilterState;
  onChange: (filters: FilterState) => void;
  onClear: () => void;
};

export const FilterPanel = ({ filters, onChange, onClear }: FilterPanelProps) => {
  const styles = useStyles();

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

      <div className={styles.filtersGrid}>
        <Card className={styles.filterCard}>
          <Label className={styles.filterTitle}>Folders</Label>
          <FolderTreeFilter
            value={filters.directories ?? []}
            onChange={(directories) =>
              onChange({
                ...filters,
                directories: directories.length > 0 ? directories : undefined,
              })
            }
          />
        </Card>

        <Card className={styles.filterCard}>
          <Label className={styles.filterTitle}>Star Rating</Label>
          <Label size="small">Minimum rating</Label>
          <StarRatingFilter
            value={filters.minRating}
            onChange={(minRating) => onChange({ ...filters, minRating })}
          />
        </Card>

        <Card className={styles.filterCard}>
          <Label className={styles.filterTitle}>Keywords/Tags</Label>
          <TagFilter
            value={filters.tags ?? []}
            onChange={(tags) =>
              onChange({ ...filters, tags: tags.length > 0 ? tags : undefined })
            }
          />
        </Card>

        <Card className={styles.filterCard}>
          <Label className={styles.filterTitle}>Date Range</Label>
          <DateSliderFilter
            value={filters.dateRange}
            onChange={(dateRange) => onChange({ ...filters, dateRange })}
          />
        </Card>

        <Card className={styles.filterCard}>
          <Label className={styles.filterTitle}>Location (Map)</Label>
          <Label size="small">Move the map to filter by location</Label>
          <MapFilter
            value={filters.location}
            onChange={(location) => onChange({ ...filters, location })}
          />
        </Card>

        <Card className={styles.filterCard}>
          <Label className={styles.filterTitle}>Camera Make/Model</Label>
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
        </Card>
      </div>
    </div>
  );
};
