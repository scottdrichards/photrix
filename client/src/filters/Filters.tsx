type Params = {
  search: string;
  setSearch: (search: string) => void;
};

export const Filters: React.FC<Params> = (params) => {
  const { search, setSearch } = params;
  return (
    <div>
      <input
        type="text"
        placeholder="Search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <button>Search</button>
    </div>
  );
};
