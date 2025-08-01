import { RatingOptions, useFilter } from "../contexts/filterContext";

export const Filters: React.FC = () => {
  const { filter, setFilter } = useFilter();
  return (
    <div>
      <label style={{ display: 'block', marginBottom: 8 }}>
        Subject:
        <input
          type="text"
          value={filter.subject || ''}
          onChange={e => setFilter({ ...filter, subject: e.target.value })}
          placeholder="Enter subject keyword"
          style={{ marginLeft: 8 }}
        />
      </label>
      <label style={{ display: 'block', marginBottom: 8 }}>
        Rating:
        <span>
          {RatingOptions.map(star => (
          <span
            key={star}
            style={{
              cursor: 'pointer',
              color: (filter.Rating && +filter.Rating[0] >= +star) ? '#FFD700' : '#ccc',
              fontSize: 24,
              marginRight: 4,
            }}
            onClick={() =>
              setFilter({
                ...filter,
                Rating: filter.Rating?.at(0) === star ? undefined : RatingOptions.filter(rating => +rating >= +star),
              })
            }
            aria-label={`Set rating to ${star}`}
            role="button"
            tabIndex={0}
          >
            ★
          </span>
          ))}
        </span>
      </label>
    </div>
  );
};
