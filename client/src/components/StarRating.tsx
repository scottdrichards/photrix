import { useState } from "react";
import { Star24Filled, Star24Regular } from "@fluentui/react-icons";
import css from "./StarRating.module.css";

const STARS = [1, 2, 3, 4, 5] as const;

type StarRatingProps = {
  /** Current rating 1–5, or null/0/undefined for unrated. */
  value: number | null | undefined;
  /** Called with the new rating; clicking the current rating clears it (0). */
  onChange: (rating: number) => void;
  /** Pixel size of each star glyph. */
  size?: number;
  className?: string;
  /** Accessible label for the control group. */
  label?: string;
};

export function StarRating({
  value,
  onChange,
  size = 22,
  className,
  label = "Star rating",
}: StarRatingProps) {
  const [hover, setHover] = useState<number | null>(null);
  const current = typeof value === "number" && value > 0 ? value : 0;
  const shown = hover ?? current;

  return (
    <div
      className={className ? `${css.stars} ${className}` : css.stars}
      role="group"
      aria-label={label}
      onMouseLeave={() => setHover(null)}
    >
      {STARS.map((star) => {
        const filled = star <= shown;
        return (
          <button
            key={star}
            type="button"
            className={css.star}
            // Clicking the star that already equals the rating clears it.
            onClick={() => onChange(star === current ? 0 : star)}
            onMouseEnter={() => setHover(star)}
            aria-label={`${star} star${star === 1 ? "" : "s"}`}
            aria-pressed={star <= current}
            title={`${star} star${star === 1 ? "" : "s"}`}
          >
            {filled ? (
              <Star24Filled fontSize={size} className={css.filled} />
            ) : (
              <Star24Regular fontSize={size} className={css.empty} />
            )}
          </button>
        );
      })}
    </div>
  );
}
