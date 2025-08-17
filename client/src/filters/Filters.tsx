import { makeStyles } from "@fluentui/react-components";
import { RatingOptions, useFilter } from "../contexts/filterContext";
import { Keywords } from "./Keywords";

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
      <Keywords />
      
      <label className={styles.ratingLabel}>
        Rating:
        <div className={styles.ratingContainer}>
          {RatingOptions.map(star => (
            <span
              key={star}
              className={`${styles.star} ${
                (filter.rating && +filter.rating[0] >= +star) 
                  ? styles.starActive 
                  : styles.starInactive
              }`}
              onClick={() =>
                setFilter({
                  ...filter,
                  rating: filter.rating?.[0] === star ? undefined : RatingOptions.filter(rating => +rating >= +star),
                })
              }
              aria-label={`Set rating to ${star}`}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  setFilter({
                    ...filter,
                    rating: filter.rating?.[0] === star ? undefined : RatingOptions.filter(rating => +rating >= +star),
                  });
                }
              }}
            >
              ★
            </span>
          ))}
        </div>
      </label>
    </div>
  );
};
