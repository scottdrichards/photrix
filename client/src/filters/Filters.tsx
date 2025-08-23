import { makeStyles } from "@fluentui/react-components";
import { RatingOptions, useFilter } from "../contexts/filterContext";
import { Keywords } from "./Keywords";
import { MapView } from "../MapView";
import { FolderExplorer } from "../FolderExplorer";

const useStyles = makeStyles({
  filtersContainer: {
    padding: "16px",
    display: "flex",
    flexDirection: "column",
    gap: "16px"
  },
  ratingLabel: {
    display: "block",
    marginBottom: "8px",
    fontSize: "14px",
    fontWeight: "600",
    color: "#323130"
  },
  ratingContainer: {
    display: "flex",
    flexDirection: "column",
    gap: "4px"
  },
  ratingOption: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    padding: "2px 6px",
    borderRadius: "4px",
    cursor: "pointer",
    backgroundColor: "#ffffff",
    border: "1px solid #ddd",
    transition: "background-color 100ms, box-shadow 100ms, border-color 100ms",
    userSelect: "none",
    "&[data-selected='true']": {
      backgroundColor: "#f6e7b8",
      border: "1px solid #d4b032"
    },
    "&:hover": {
      backgroundColor: "#f0f0f0"
    },
    "&:active": {
      backgroundColor: "#ececec"
    }
  },
  ratingNumber: {
    width: "14px",
    fontSize: "11px",
    fontWeight: 600,
    color: "#605e5c"
  },
  starRow: {
    display: "flex",
    alignItems: "center",
    gap: "1px"
  },
  star: {
    cursor: "pointer",
    fontSize: "14px",
    lineHeight: 1,
    transition: "transform 80ms",
    color: "#d2d0ce",
    "&[data-active='true']": {
      color: "#ffc83d"
    },
    "&:hover": {
      transform: "scale(1.1)"
    }
  }
});

export const Filters: React.FC = () => {
  const styles = useStyles();
  const { filter, setFilter } = useFilter();

  return (
    <div className={styles.filtersContainer}>
      {JSON.stringify(filter, null, 2)}
      <FolderExplorer />
      <Keywords />
      
      <div>
        <div className={styles.ratingLabel}>Rating</div>
        <div className={styles.ratingContainer}>
          {RatingOptions.map(rating => {
            const selected = filter.rating?.includes(rating) ?? false;
            return (
              <div
                key={rating}
                className={styles.ratingOption}
                data-selected={selected || undefined}
                onClick={() => {
                  setFilter({
                    ...filter,
                    rating: selected
                      ? filter.rating!.filter(r => r !== rating)
                      : (filter.rating ? [...filter.rating, rating] : [rating])
                  });
                }}
              >
                <span className={styles.ratingNumber}>{rating}</span>
                <div className={styles.starRow}>
                  {[1,2,3,4,5].map(starIndex => (
                    <span
                      key={starIndex}
                      className={styles.star}
                      data-active={starIndex <= Number(rating) || undefined}
                    >
                      ★
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <MapView />
    </div>
  );
};
