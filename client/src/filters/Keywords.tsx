import { makeStyles } from "@fluentui/react-components";
import { useFilter } from "../contexts/filterContext";
import { useOptions } from "../hooks/useOptions";
import { Keyword } from "./Keyword";

const useStyles = makeStyles({
  keywordsContainer: {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
    marginBottom: "16px"
  }
});

export const Keywords: React.FC = () => {
  const styles = useStyles();
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

  const keywordFilterNotFoundInResults = filter.keywords?.filter(
    keyword => !keywordOptions?.includes(keyword)
  );

  return (
    <div className={styles.keywordsContainer}>
      {keywordOptions?.map(keyword => (
        <Keyword 
          key={keyword} 
          name={keyword} 
          state={filter.keywords?.includes(keyword) ? 'active' : 'inactive'}
          onClick={toggleKeyword}
        />
      ))}
      {keywordFilterNotFoundInResults?.map(keyword => (
        <Keyword 
          key={keyword} 
          name={keyword} 
          state='notFound'
          onClick={toggleKeyword}
        />
      ))}
    </div>
  );
};
