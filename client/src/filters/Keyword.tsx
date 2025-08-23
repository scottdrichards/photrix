import { makeStyles } from "@fluentui/react-components";

const useStyles = makeStyles({
  keyword: {
  // Rely on parent flex gap; remove individual margin
  cursor: "pointer",
  padding: "2px 6px",
  borderRadius: "3px",
  display: "inline-block",
  transition: "all 0.15s ease",
  border: "1px solid transparent",
  fontSize: "12px",
  lineHeight: 1.2,
    "&:hover": {
      backgroundColor: "#f3f2f1"
    }
  },
  inactive: {
    fontWeight: "normal",
    color: "#605e5c",
    backgroundColor: "#faf9f8",
    border: "1px solid #d2d0ce"
  },
  active: {
    fontWeight: "bold",
    color: "#ffffff",
    backgroundColor: "#0078d4",
    border: "1px solid #106ebe",
    "&:hover": {
      backgroundColor: "#106ebe"
    }
  },
  notFound: {
    fontWeight: "normal",
    color: "#d13438",
    backgroundColor: "#fdf3f4",
    border: "1px solid #f1707b"
  }
});

export interface KeywordProps {
  name: string;
  state: 'inactive' | 'active' | 'notFound';
  onClick: (keyword: string) => void;
  count?: number;
}

export const Keyword: React.FC<KeywordProps> = ({ name, state, onClick, count }) => {
  const styles = useStyles();
  
  return (
    <span 
      className={`${styles.keyword} ${styles[state]}`}
      onClick={() => onClick(name)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          onClick(name);
        }
      }}
    >
      {name}{count && ` (${count})`}
    </span>
  );
};
