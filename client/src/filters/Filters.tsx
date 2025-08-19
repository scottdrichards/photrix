import { makeStyles } from "@fluentui/react-components";
import { RatingOptions, useFilter } from "../contexts/filterContext";
import { Keywords } from "./Keywords";
import { MapView } from "../MapView";

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
    alignItems: "center",
    gap: "4px"
  },
  star: {
    cursor: "pointer",
    fontSize: "24px",
    marginRight: "4px",
    transition: "all 0.2s ease",
    "&:hover": {
      transform: "scale(1.1)"
    }
  },
  starActive: {
    color: "#FFD700"
  },
  starInactive: {
    color: "#d2d0ce"
  }
});

export const Filters: React.FC = () => {
  const styles = useStyles();
  const { filter, setFilter } = useFilter();

  return (
    <div className={styles.filtersContainer}>
      {JSON.stringify(filter, null, 2)}
      <Keywords />
      
      <label className={styles.ratingLabel}>
        Rating:
        <div className={styles.ratingContainer}>
          {RatingOptions.map(rating=>
            <div key={rating} style={{ backgroundColor: filter.rating?.includes(rating) && '#2e2e2eff' || undefined }}
              onClick={() =>
                setFilter({
                  ...filter,
                  rating: filter.rating?.includes(rating) ?
                    filter.rating.filter(r => r !== rating) :
                    filter?.rating?.concat(rating) || [rating],
                })
              }>
              {RatingOptions.map(star => (
              <span
                key={star}
                className={`${styles.star} ${
                  (star <= rating) 
                    ? styles.starActive 
                  : styles.starInactive
              }`}
            >
              ★
            </span>
          ))}</div>)}
        </div>
      </label>
      <MapView />
    </div>
  );
};
