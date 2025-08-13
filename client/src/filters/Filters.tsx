import { useEffect, useState } from "react";
import { RatingOptions, useFilter } from "../contexts/filterContext";
import { getColumnDistinctValues } from "../data/api";

export const Filters: React.FC = () => {
  const { filter, setFilter } = useFilter();
  const [subjectOptions, setSubjectOptions] = useState<string[]>([]);
  const [loadingSubjects, setLoadingSubjects] = useState(false);

  useEffect(() => {
    const loadSubjectOptions = async () => {
      setLoadingSubjects(true);
      try {
        const subjects = await getColumnDistinctValues("hierarchical_subject", filter);
        setSubjectOptions(subjects);
      } catch (error) {
        console.error("Error loading subject options:", error);
      } finally {
        setLoadingSubjects(false);
      }
    };

    loadSubjectOptions();
  }, []);

  return (
    <div>
      <label style={{ display: 'block', marginBottom: 8 }}>
        Subject:
        {loadingSubjects ? (
          <span style={{ marginLeft: 8 }}>Loading...</span>
        ) : (
          <select
            value={filter.hierarchical_subject || ''}
            onChange={e => {
              const {hierarchical_subject, ...rest} = filter;
              const newHierarchicalSubject = e.target.value || undefined;
              setFilter(newHierarchicalSubject ? {...rest, hierarchical_subject: newHierarchicalSubject} : rest);
            }}
            style={{ marginLeft: 8 }}
          >
            <option value="">All subjects</option>
            {subjectOptions.map(subject => (
              <option key={subject} value={subject}>
                {subject}
              </option>
            ))}
          </select>
        )}
      </label>
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
