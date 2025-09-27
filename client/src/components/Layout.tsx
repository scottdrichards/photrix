import { Outlet } from 'react-router-dom'
import { 
  Toolbar, 
  ToolbarButton,
  Title3,
  makeStyles,
  shorthands
} from '@fluentui/react-components'
import { 
  Camera24Regular,
  Search24Regular, 
  Settings24Regular, 
  Person24Regular 
} from '@fluentui/react-icons'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
  },
  header: {
    ...shorthands.padding('16px', '24px'),
    ...shorthands.borderBottom('1px', 'solid', '#e1e1e1'),
    backgroundColor: '#ffffff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: '64px',
  },
  brandContainer: {
    display: 'flex',
    alignItems: 'center',
    ...shorthands.gap('12px'),
  },
  main: {
    flex: '1',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
})

export default function Layout() {
  const styles = useStyles()

  return (
    <div className={styles.root}>
      {/* Top Header */}
      <header className={styles.header}>
        <div className={styles.brandContainer}>
          <Camera24Regular />
          <Title3 as="h1">Photrix</Title3>
        </div>
        
        <Toolbar>
          <ToolbarButton 
            aria-label="Search"
            icon={<Search24Regular />}
          />
          <ToolbarButton 
            aria-label="Settings"
            icon={<Settings24Regular />}
          />
          <ToolbarButton 
            aria-label="Profile"
            icon={<Person24Regular />}
          />
        </Toolbar>
      </header>

      {/* Main Content Area - Vertical Layout */}
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  )
}