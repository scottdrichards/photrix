import { makeStyles, tokens } from "@fluentui/react-components";
import { Star24Filled, Star24Regular } from "@fluentui/react-icons";

const useStyles = makeStyles({
  container: {
    display: "flex",
    gap: tokens.spacingHorizontalXS,
    alignItems: "center",
  },
  starButton: {
    background: "none",
    border: "none",
    padding: "4px",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    color: tokens.colorNeutralForeground3,
    transition: "color 0.2s",
    ":hover": {
      color: tokens.colorBrandForeground1,
    },
  },
  starActive: {
    color: tokens.colorBrandForeground1,
  },
});

export type StarRatingFilterProps = {
  value?: number;
  onChange: (rating?: number) => void;
};

export const StarRatingFilter = ({ value, onChange }: StarRatingFilterProps) => {
  const styles = useStyles();
  const maxStars = 5;

  const handleStarClick = (rating: number) => {
    if (value === rating) {
      onChange(undefined);
    } else {
      onChange(rating);
    }
  };

  return (
    <div className={styles.container}>
      {Array.from({ length: maxStars }, (_, index) => {
        const starValue = index + 1;
        const isActive = value !== undefined && starValue <= value;
        return (
          <button
            key={starValue}
            type="button"
            className={`${styles.starButton} ${isActive ? styles.starActive : ""}`}
            onClick={() => handleStarClick(starValue)}
            aria-label={`${starValue} star${starValue > 1 ? "s" : ""}`}
          >
            {isActive ? <Star24Filled /> : <Star24Regular />}
          </button>
        );
      })}
    </div>
  );
};
