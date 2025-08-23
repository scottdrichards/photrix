import { useState } from "react";
import { Input } from "@fluentui/react-components";
import { useFilter } from "../contexts/filterContext";
import { useOptions } from "../hooks/useOptions";
import { Keyword } from "./Keyword";
import { useStyles } from "./Keywords.styles";

export const Keywords: React.FC = () => {
  const styles = useStyles();
  const [searchTerm, setSearchTerm] = useState("");
  const { filter, setFilter } = useFilter();
  const keywordOptions = useOptions("keywords");

  const toggleKeyword = (keyword: string) => {
    const removeKeyword = filter.keywords?.includes(keyword);
    const keywords = removeKeyword 
      ? filter.keywords?.filter(k => k !== keyword) || [] 
      : [...(filter.keywords || []), keyword];
    
    setFilter({
      ...filter,
      keywords: keywords?.length > 0 ? keywords : undefined 
    });
  };

  // Filter keywords based on search term
  const filteredKeywords = keywordOptions?.filter(option =>
    option.value.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className={styles.keywordsContainer}>
      <div className={styles.searchSection}>
  <span style={{fontSize: '12px', opacity: 0.7}}>🔍</span>
  <Input
          id="keyword-search"
          className={styles.searchInput}
          placeholder="search keywords"
          aria-label="search keywords"
          value={searchTerm}
          onChange={(_, data) => setSearchTerm(data.value)}
          appearance="outline"
        />
        <button
          type="button"
          className={styles.clearButton}
          aria-label="clear search"
          disabled={!searchTerm}
          onClick={() => setSearchTerm("")}
          title="Clear"
        >✕</button>
      </div>
      
      <div>
        <div className={styles.keywordsHeader}>
          {filteredKeywords?.length || 0} match{(filteredKeywords?.length||0)!==1 && 'es'}
        </div>
        <div className={styles.keywordsList}>
            {filteredKeywords?.sort((a, b) => {
              const aSelected = filter.keywords?.includes(a.value) ? 1 : 0;
              const bSelected = filter.keywords?.includes(b.value) ? 1 : 0;
              
              // First sort by selected status (selected first)
              if (aSelected !== bSelected) {
                return bSelected - aSelected;
              }
              
              // Then sort by count
              return b.count - a.count;
            })
            .slice(0, 20)
            .map(({value:keyword, count}) => (
            <Keyword 
              key={keyword} 
              name={keyword} 
              count={count}
              state={filter.keywords?.find(option=>option===keyword) ? 'active' : 'inactive'}
              onClick={toggleKeyword}
            />
            ))}
          {filter.keywords?.filter(
            keyword => !keywordOptions?.find(option=>option.value==(keyword))
          )?.map(keyword => (
            <Keyword 
              key={keyword} 
              name={keyword} 
              state='notFound'
              onClick={toggleKeyword}
            />
          ))}
        </div>
      </div>
    </div>
  );
};
