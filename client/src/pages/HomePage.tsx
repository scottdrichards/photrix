import { useState } from 'react'
import { 
  Button,
  ToggleButton,
  Card,
  Text,
  Title2,
  Subtitle1,
  Body1,
  Field,
  Input,
  Checkbox,
  makeStyles,
  shorthands
} from '@fluentui/react-components'
import { 
  GridDots24Regular,
  List24Regular,
  CloudArrowUp24Regular,
  Camera24Regular,
  Filter24Regular
} from '@fluentui/react-icons'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    ...shorthands.overflow('hidden'),
  },
  filtersSection: {
    ...shorthands.padding('16px', '24px'),
    backgroundColor: '#fafafa',
    ...shorthands.borderBottom('1px', 'solid', '#e1e1e1'),
  },
  filtersContainer: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    ...shorthands.gap('16px'),
    alignItems: 'end',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    ...shorthands.padding('16px', '24px'),
    ...shorthands.borderBottom('1px', 'solid', '#e1e1e1'),
    backgroundColor: '#ffffff',
  },
  toolbarLeft: {
    display: 'flex',
    alignItems: 'center',
    ...shorthands.gap('8px'),
  },
  toolbarRight: {
    display: 'flex',
    alignItems: 'center',
    ...shorthands.gap('8px'),
  },
  viewToggle: {
    display: 'flex',
  },
  mainContent: {
    flex: '1',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    ...shorthands.padding('48px', '24px'),
  },
  emptyState: {
    textAlign: 'center',
    maxWidth: '400px',
  },
  emptyIcon: {
    fontSize: '64px',
    color: '#d1d1d1',
    marginBottom: '16px',
  },
  detailsSection: {
    ...shorthands.padding('16px', '24px'),
    backgroundColor: '#fafafa',
    ...shorthands.borderTop('1px', 'solid', '#e1e1e1'),
    minHeight: '120px',
  },
})

export default function HomePage() {
  const [isFiltersVisible, setIsFiltersVisible] = useState(true)
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const styles = useStyles()

  return (
    <div className={styles.root}>
      {/* Filters Section - Horizontal at top */}
      {isFiltersVisible && (
        <section className={styles.filtersSection}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <Subtitle1>Filters</Subtitle1>
            <Button
              appearance="subtle"
              size="small"
              onClick={() => setIsFiltersVisible(false)}
            >
              ✕
            </Button>
          </div>
          
          <div className={styles.filtersContainer}>
            <Field label="Date Range">
              <Input type="date" size="small" />
            </Field>
            
            <Field label="Tags">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <Checkbox label="Favorites" />
                <Checkbox label="People" />
              </div>
            </Field>
            
            <Field label="Location">
              <Card style={{ height: '80px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Body1 style={{ color: '#757575' }}>Map View (To be implemented)</Body1>
              </Card>
            </Field>
          </div>
        </section>
      )}

      {/* Toolbar */}
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          {!isFiltersVisible && (
            <Button
              appearance="subtle"
              icon={<Filter24Regular />}
              onClick={() => setIsFiltersVisible(true)}
            >
              Show Filters
            </Button>
          )}
          <Text size={300}>0 photos</Text>
        </div>
        
        <div className={styles.toolbarRight}>
          <Button
            appearance="primary"
            icon={<CloudArrowUp24Regular />}
          >
            Upload Photos
          </Button>
          
          <div className={styles.viewToggle}>
            <ToggleButton
              checked={viewMode === 'grid'}
              onClick={() => setViewMode('grid')}
              icon={<GridDots24Regular />}
            />
            <ToggleButton
              checked={viewMode === 'list'}
              onClick={() => setViewMode('list')}
              icon={<List24Regular />}
            />
          </div>
        </div>
      </div>

      {/* Main Photo Area */}
      <div className={styles.mainContent}>
        <div className={styles.emptyState}>
          <Camera24Regular className={styles.emptyIcon} />
          <Title2 style={{ marginBottom: '8px' }}>No photos yet</Title2>
          <Body1 style={{ marginBottom: '24px', color: '#757575' }}>
            Upload your first photos to get started
          </Body1>
          <Button
            appearance="primary"
            size="large"
            icon={<CloudArrowUp24Regular />}
          >
            Upload Photos
          </Button>
        </div>
      </div>

      {/* Details Section - Bottom */}
      <section className={styles.detailsSection}>
        <Subtitle1 style={{ marginBottom: '8px' }}>Photo Details</Subtitle1>
        <Body1 style={{ color: '#757575' }}>Select a photo to view details</Body1>
      </section>
    </div>
  )
}