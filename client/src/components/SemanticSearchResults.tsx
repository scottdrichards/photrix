import { useEffect, useState } from "react";
import type { PhotoItem } from "../api";
import { fetchSemanticSearch } from "../api";
import { Spinner } from "../Spinner";
import { useFilter } from "./filter/FilterContext";
import { ThumbnailTile } from "./ThumbnailTile";
import css from "./SemanticSearchResults.module.css";

type Props = {
  query: string;
};

export const SemanticSearchResults = ({ query }: Props) => {
  const { filter } = useFilter();
  const [items, setItems] = useState<PhotoItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!query.trim()) return;

    const abortController = new AbortController();
    setLoading(true);
    setError(null);

    fetchSemanticSearch({
      q: query,
      limit: 100,
      signal: abortController.signal,
      ...filter,
    })
      .then((result) => {
        setItems(result.items);
        setTotal(result.total);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      })
      .finally(() => setLoading(false));

    return () => abortController.abort();
  }, [query, filter]);

  if (loading) {
    return (
      <div className={css.center}>
        <Spinner />
        <span>Searching…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className={css.center}>
        <p className={css.error}>Search failed: {error}</p>
        {error.includes("unavailable") && (
          <p className={css.hint}>
            Install CLIP: <code>npm --prefix server run clip:python:install</code>
          </p>
        )}
      </div>
    );
  }

  if (!items.length) {
    return (
      <div className={css.center}>
        <p>No results for &ldquo;{query}&rdquo;</p>
        <p className={css.hint}>Images need to be indexed first (check the Status panel).</p>
      </div>
    );
  }

  return (
    <div className={css.results}>
      <p className={css.resultCount}>
        {total} result{total !== 1 ? "s" : ""} for &ldquo;{query}&rdquo;
      </p>
      <div className={css.grid}>
        {items.map((item) => (
          <ThumbnailTile key={item.path} photo={item} />
        ))}
      </div>
    </div>
  );
};
