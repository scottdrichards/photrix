import { RatingOptions, useFilter } from "../contexts/filterContext";
import { useOptions } from "../hooks/useOptions";

export const Filters: React.FC = () => {
  const { filter, setFilter } = useFilter();
  const keywordOptions = useOptions("keywords");

  const toggleKeyword = (keyword: string) => {
    const removeKeyword = filter.keywords?.includes(keyword);
    const keywords = removeKeyword ? filter.keywords?.filter(k => k !== keyword)||[] : [...(filter.keywords || []), keyword];
    setFilter({
      ...filter,
      keywords:keywords?.length > 0 ? keywords : undefined 
    });
  };

  return (
    <div>
      <div>
        {keywordOptions?.map(keyword => (
          <span key={keyword} style={{ marginRight: 8, fontWeight: filter.keywords?.includes(keyword) ? 'bold' : 'normal' }} onClick={() => toggleKeyword(keyword)}>
            {keyword}
          </span>
        ))}
      </div>
      <label style={{ display: 'block', marginBottom: 8 }}>
        Rating:
        <span>
          {RatingOptions.map(star => (
          <span
            key={star}
            style={{
              cursor: 'pointer',
              color: (filter.rating && +filter.rating[0] >= +star) ? '#FFD700' : '#ccc',
              fontSize: 24,
              marginRight: 4,
            }}
            onClick={() =>
              setFilter({
                ...filter,
                rating: filter.rating?.[0] === star ? undefined : RatingOptions.filter(rating => +rating >= +star),
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
