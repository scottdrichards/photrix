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

  return (
    <div className={styles.keywordsContainer}>
      {keywordOptions?.sort((a,b)=>b.count-a.count)
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
  );
};
